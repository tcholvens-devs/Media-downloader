let selectedFormat = null;
let currentMedia = null;
let pollInterval = null;

const urlInput = document.getElementById("urlInput");
const clearBtn = document.getElementById("clearBtn");

urlInput.addEventListener("input", () => {
  clearBtn.style.display = urlInput.value ? "block" : "none";
});

urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") analyze();
});

function clearInput() {
  urlInput.value = "";
  clearBtn.style.display = "none";
  urlInput.focus();
  hideResult();
  hideError();
}

function showError(msg) {
  const box = document.getElementById("errorBox");
  document.getElementById("errorMsg").textContent = msg;
  box.classList.remove("hidden");
}

function hideError() {
  document.getElementById("errorBox").classList.add("hidden");
}

function hideResult() {
  document.getElementById("result").classList.add("hidden");
}

function setAnalyzeLoading(loading) {
  const btn = document.getElementById("analyzeBtn");
  const txt = document.getElementById("analyzeBtnText");
  const spinner = document.getElementById("analyzeBtnSpinner");
  btn.disabled = loading;
  if (loading) {
    txt.textContent = "Analyse...";
    spinner.classList.remove("hidden");
  } else {
    txt.textContent = "Analyser";
    spinner.classList.add("hidden");
  }
}

function formatDuration(secs) {
  if (!secs) return "";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  return `${m}:${String(s).padStart(2,"0")}`;
}

async function analyze() {
  const url = urlInput.value.trim();
  if (!url) { showError("Entre un lien d'abord."); return; }

  hideError();
  hideResult();
  setAnalyzeLoading(true);
  selectedFormat = null;

  try {
    const res = await fetch("/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    const data = await res.json();

    if (!res.ok) {
      showError(data.error || "Erreur serveur");
      return;
    }

    currentMedia = data;
    renderResult(data);

  } catch (err) {
    showError("Impossible de joindre le serveur. Réessaie.");
  } finally {
    setAnalyzeLoading(false);
  }
}

function renderResult(data) {
  document.getElementById("thumbnail").src = data.thumbnail || "";
  document.getElementById("videoTitle").textContent = data.title || "Sans titre";
  document.getElementById("uploaderName").textContent = data.uploader || "";
  document.getElementById("platformLabel").textContent = data.platform || "";

  const dur = formatDuration(data.duration);
  const durBadge = document.getElementById("durationBadge");
  durBadge.textContent = dur;
  durBadge.style.display = dur ? "block" : "none";

  const grid = document.getElementById("formatsGrid");
  grid.innerHTML = "";
  selectedFormat = null;
  document.getElementById("downloadBtn").disabled = true;

  (data.formats || []).forEach((fmt, i) => {
    const btn = document.createElement("button");
    btn.className = "format-btn" + (fmt.type === "audio" ? " audio" : "");
    btn.textContent = fmt.label;
    if (fmt.type === "audio") btn.title = "Audio seulement";
    btn.addEventListener("click", () => {
      document.querySelectorAll(".format-btn").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      selectedFormat = fmt;
      document.getElementById("downloadBtn").disabled = false;
    });
    grid.appendChild(btn);

    if (i === 0) {
      btn.click();
    }
  });

  document.getElementById("progressSection").classList.add("hidden");
  document.getElementById("doneSection").classList.add("hidden");
  document.getElementById("downloadBtn").style.display = "";
  document.getElementById("result").classList.remove("hidden");
}

async function startDownload() {
  if (!selectedFormat || !currentMedia) return;

  document.getElementById("downloadBtn").disabled = true;
  document.getElementById("progressSection").classList.remove("hidden");
  document.getElementById("doneSection").classList.add("hidden");
  document.getElementById("progressFill").style.width = "0%";
  document.getElementById("progressPct").textContent = "0%";
  document.getElementById("progressLabel").textContent = "Démarrage...";

  try {
    const res = await fetch("/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: currentMedia.url,
        formatId: selectedFormat.id,
        title: currentMedia.title
      })
    });
    const data = await res.json();
    if (!res.ok || !data.jobId) {
      showError(data.error || "Erreur au démarrage du téléchargement");
      document.getElementById("downloadBtn").disabled = false;
      return;
    }
    pollProgress(data.jobId);
  } catch {
    showError("Erreur réseau. Réessaie.");
    document.getElementById("downloadBtn").disabled = false;
  }
}

function pollProgress(jobId) {
  if (pollInterval) clearInterval(pollInterval);

  document.getElementById("progressLabel").textContent = "Téléchargement en cours...";

  pollInterval = setInterval(async () => {
    try {
      const res = await fetch(`/status/${jobId}`);
      const job = await res.json();

      const pct = Math.round(job.progress || 0);
      document.getElementById("progressFill").style.width = `${pct}%`;
      document.getElementById("progressPct").textContent = `${pct}%`;

      if (job.status === "completed") {
        clearInterval(pollInterval);
        document.getElementById("progressSection").classList.add("hidden");
        document.getElementById("downloadBtn").style.display = "none";

        const doneSection = document.getElementById("doneSection");
        doneSection.classList.remove("hidden");

        const link = document.getElementById("downloadLink");
        link.href = job.downloadUrl;
        link.download = "";

        link.click();

      } else if (job.status === "failed") {
        clearInterval(pollInterval);
        showError(job.error || "Le téléchargement a échoué.");
        document.getElementById("progressSection").classList.add("hidden");
        document.getElementById("downloadBtn").disabled = false;
      }
    } catch {
      clearInterval(pollInterval);
      showError("Perte de connexion avec le serveur.");
    }
  }, 800);
}
