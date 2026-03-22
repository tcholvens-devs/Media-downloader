const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const YTDlpWrap = require("yt-dlp-wrap").default;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../Frontend")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../Frontend/index.html"));
});

const DOWNLOADS_DIR = path.join(__dirname, "../downloads");
const BIN_PATH = path.join(__dirname, "../yt-dlp");

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
if (!fs.existsSync(path.join(__dirname, "../bin"))) fs.mkdirSync(path.join(__dirname, "../bin"), { recursive: true });

const jobs = {};
let ytDlpWrap = null;

const https = require("https");

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = (reqUrl) => {
      https.get(reqUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return request(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      }).on("error", reject);
    };
    request(url);
  });
}

async function initYtDlp() {
  if (fs.existsSync(BIN_PATH)) {
    try {
      ytDlpWrap = new YTDlpWrap(BIN_PATH);
      const ver = await ytDlpWrap.getVersion();
      console.log(`yt-dlp binary ready (v${ver})`);
      return;
    } catch {
      console.log("Existing binary failed, re-downloading...");
    }
  }
  console.log("Downloading yt-dlp standalone binary...");
  try {
    const url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";
    await downloadFile(url, BIN_PATH);
    fs.chmodSync(BIN_PATH, 0o755);
    ytDlpWrap = new YTDlpWrap(BIN_PATH);
    const ver = await ytDlpWrap.getVersion();
    console.log(`yt-dlp downloaded and ready (v${ver})`);
  } catch (err) {
    console.error("Failed to download yt-dlp binary:", err.message);
  }
}

function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/.test(url)) return "YouTube";
  if (/tiktok\.com/.test(url)) return "TikTok";
  if (/instagram\.com/.test(url)) return "Instagram";
  if (/twitter\.com|x\.com/.test(url)) return "Twitter/X";
  if (/facebook\.com/.test(url)) return "Facebook";
  if (/vimeo\.com/.test(url)) return "Vimeo";
  return "Web";
}

app.post("/analyze", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL manquante" });
  if (!ytDlpWrap) return res.status(503).json({ error: "Le service de téléchargement est en cours d'initialisation, réessaie dans quelques secondes." });

  try {
    const info = await ytDlpWrap.getVideoInfo(["--no-playlist", url]);
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
  } catch (err) {
    console.error("analyze error:", err.message);
    res.status(500).json({ error: "Impossible d'analyser cette URL", details: err.message.slice(0, 300) });
  }
});

app.post("/download", (req, res) => {
  const { url, formatId, title } = req.body;
  if (!url) return res.status(400).json({ error: "URL manquante" });
  if (!ytDlpWrap) return res.status(503).json({ error: "Service non prêt, réessaie dans quelques secondes." });

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

  const args = ["--no-playlist", "--newline", "-o", outputTemplate];

  if (formatId === "bestaudio/best") {
    args.push("-f", "bestaudio/best", "--extract-audio", "--audio-format", "mp3", "--audio-quality", "0");
  } else if (formatId && formatId !== "bestvideo+bestaudio/best") {
    args.push("-f", `${formatId}+bestaudio/best`, "--merge-output-format", "mp4");
  } else {
    args.push("-f", "bestvideo+bestaudio/best", "--merge-output-format", "mp4");
  }

  args.push(url);

  ytDlpWrap.exec(args)
    .on("progress", (progress) => {
      if (progress.percent != null) {
        jobs[jobId].progress = progress.percent;
      }
    })
    .on("error", (err) => {
      console.error("download error:", err.message);
      jobs[jobId].status = "failed";
      jobs[jobId].error = err.message.slice(0, 200);
    })
    .on("close", () => {
      const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.startsWith(jobId));
      if (files.length > 0) {
        jobs[jobId].status = "completed";
        jobs[jobId].progress = 100;
        jobs[jobId].filename = files[0];
        jobs[jobId].downloadUrl = `/file/${jobId}`;
      } else if (jobs[jobId].status !== "failed") {
        jobs[jobId].status = "failed";
        jobs[jobId].error = "Fichier introuvable après téléchargement";
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

app.get("/ready", (req, res) => {
  res.json({ ready: !!ytDlpWrap });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Serveur lancé sur http://localhost:${PORT}`);
  await initYtDlp();
  console.log("yt-dlp prêt !");
});