const express = require("express");
const cors = require("cors");
const path = require("path");
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const PYTHON = "/nix/store/nki9ywqzbvz68vr75kn2r7g1q84f5agy-python3-3.9.6/bin/python3";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../Frontend/index.html")));

const DOWNLOADS_DIR = path.join(__dirname, "../downloads");
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

const jobs = {};

function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/.test(url)) return "YouTube";
  if (/tiktok\.com/.test(url)) return "TikTok";
  if (/instagram\.com/.test(url)) return "Instagram";
  if (/twitter\.com|x\.com/.test(url)) return "Twitter/X";
  if (/facebook\.com/.test(url)) return "Facebook";
  if (/vimeo\.com/.test(url)) return "Vimeo";
  return "Web";
}

app.post("/analyze", (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL manquante" });

  execFile(PYTHON, [
    "-m", "yt_dlp",
    "--dump-json",
    "--no-playlist",
    url
  ], { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.error("yt-dlp error:", stderr);
      return res.status(500).json({ error: "Impossible d'analyser cette URL", details: stderr.slice(0, 300) });
    }

    try {
      const info = JSON.parse(stdout);
      const platform = detectPlatform(url);

      const seenRes = new Set();
      const formats = [];

      const videoFormats = (info.formats || [])
        .filter(f => f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none")
        .sort((a, b) => (b.height || 0) - (a.height || 0));

      for (const f of videoFormats) {
        const label = f.height ? `${f.height}p` : f.format_note || f.format_id;
        if (!seenRes.has(label)) {
          seenRes.add(label);
          formats.push({
            id: f.format_id,
            label,
            ext: f.ext,
            filesize: f.filesize || f.filesize_approx || null,
            note: f.format_note || "",
            type: "video"
          });
        }
      }

      const hasVideo = (info.formats || []).some(f => f.vcodec && f.vcodec !== "none");
      if (hasVideo) {
        formats.unshift({
          id: "bestvideo+bestaudio/best",
          label: "Meilleure qualité",
          ext: "mp4",
          filesize: null,
          note: "Vidéo + Audio",
          type: "video"
        });
      }

      formats.push({
        id: "bestaudio/best",
        label: "Audio MP3",
        ext: "mp3",
        filesize: null,
        note: "Audio seulement",
        type: "audio"
      });

      res.json({
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration,
        uploader: info.uploader || info.channel,
        platform,
        url,
        formats: formats.slice(0, 8)
      });
    } catch (parseErr) {
      res.status(500).json({ error: "Erreur de parsing", details: parseErr.message });
    }
  });
});

app.post("/download", (req, res) => {
  const { url, formatId, title } = req.body;
  if (!url) return res.status(400).json({ error: "URL manquante" });

  const jobId = uuidv4();
  const outputTemplate = path.join(DOWNLOADS_DIR, `${jobId}.%(ext)s`);

  jobs[jobId] = {
    id: jobId,
    url,
    title: title || "Vidéo",
    status: "downloading",
    progress: 0,
    filename: null,
    error: null,
    createdAt: new Date().toISOString()
  };

  const args = ["-m", "yt_dlp", "--no-playlist", "--newline", "-o", outputTemplate];

  if (formatId === "bestaudio/best") {
    args.push("-f", "bestaudio/best", "--extract-audio", "--audio-format", "mp3", "--audio-quality", "0");
  } else if (formatId && formatId !== "bestvideo+bestaudio/best") {
    args.push("-f", `${formatId}+bestaudio/best`, "--merge-output-format", "mp4");
  } else {
    args.push("-f", "bestvideo+bestaudio/best", "--merge-output-format", "mp4");
  }

  args.push(url);

  const proc = spawn(PYTHON, args);

  proc.stdout.on("data", (data) => {
    const line = data.toString();
    const match = line.match(/(\d+\.?\d*)%/);
    if (match) {
      jobs[jobId].progress = parseFloat(match[1]);
    }
  });

  proc.stderr.on("data", (data) => {
    console.error("yt-dlp stderr:", data.toString().trim());
  });

  proc.on("close", (code) => {
    if (code === 0) {
      const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.startsWith(jobId));
      if (files.length > 0) {
        jobs[jobId].status = "completed";
        jobs[jobId].progress = 100;
        jobs[jobId].filename = files[0];
        jobs[jobId].downloadUrl = `/file/${jobId}`;
      } else {
        jobs[jobId].status = "failed";
        jobs[jobId].error = "Fichier introuvable après téléchargement";
      }
    } else {
      jobs[jobId].status = "failed";
      jobs[jobId].error = "Téléchargement échoué (code " + code + ")";
    }
  });

  res.json({ jobId });
});

app.get("/status/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Job introuvable" });
  res.json(job);
});

app.get("/file/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || !job.filename) return res.status(404).json({ error: "Fichier introuvable" });

  const filePath = path.join(DOWNLOADS_DIR, job.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Fichier supprimé" });

  const safeName = (job.title || "video").replace(/[^a-zA-Z0-9\-_. ]/g, "_").slice(0, 80) + path.extname(job.filename);
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  res.sendFile(filePath);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur lancé sur http://localhost:${PORT}`);
});