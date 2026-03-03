const nameStroke = document.getElementById("nameStroke");
const arabicMessage = document.getElementById("arabicMessage");
const englishMessage = document.getElementById("englishMessage");
const flowerWrap = document.getElementById("flowerWrap");
const petals = Array.from(document.querySelectorAll(".petal"));
const coreRing = document.getElementById("coreRing");
const photoWall = document.getElementById("photoWall");
const wallGrid = document.getElementById("wallGrid");
const playlistPanel = document.getElementById("playlistPanel");
const flowerEnabled = Boolean(flowerWrap && coreRing && petals.length);

const manifestEntries = Array.isArray(window.PHOTO_MEDIA) ? window.PHOTO_MEDIA : [];
const legacyManifestFiles = Array.isArray(window.PHOTO_MEDIA_FILES) ? window.PHOTO_MEDIA_FILES : [];

function normalizeRelativePath(pathValue) {
  return String(pathValue || "")
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "");
}

function toMediaPath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) {
    return "";
  }

  return `photos/${normalized
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

function getMediaKind(fileName, hintedKind = "") {
  if (hintedKind === "image" || hintedKind === "video") {
    return hintedKind;
  }

  return /\.(mp4|webm|ogg|mov)$/i.test(fileName) ? "video" : "image";
}

function normalizePlaylistId(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const match = /playlist\/([a-zA-Z0-9]+)/.exec(raw);
  if (match) {
    return match[1];
  }

  return /^[a-zA-Z0-9]+$/.test(raw) ? raw : "";
}

function deriveImageThumb(fileName) {
  const base = String(fileName || "").replace(/\.[^/.]+$/, "");
  return `_thumbs/${base}.thumb.jpg`;
}

function normalizeEntry(rawEntry) {
  const file = normalizeRelativePath(rawEntry?.file);
  if (!file) {
    return null;
  }

  const kind = getMediaKind(file, rawEntry?.kind);
  const webRelative = normalizeRelativePath(rawEntry?.web);
  const sourceRelative = kind === "image" && webRelative ? webRelative : file;
  const src = toMediaPath(sourceRelative);
  const thumbRelative = normalizeRelativePath(rawEntry?.thumb);
  const thumbPath = thumbRelative ? toMediaPath(thumbRelative) : "";

  return {
    src,
    kind,
    thumb: kind === "image" ? thumbPath || toMediaPath(deriveImageThumb(file)) : thumbPath
  };
}

const photos =
  manifestEntries.length > 0
    ? manifestEntries
        .map((entry) => normalizeEntry(entry))
        .filter((entry) => Boolean(entry?.src))
    : legacyManifestFiles.map((fileName) => {
        const kind = getMediaKind(fileName);
        return {
          src: toMediaPath(fileName),
          kind,
          thumb: kind === "image" ? toMediaPath(deriveImageThumb(fileName)) : ""
        };
      });

const state = {
  flowerReady: false,
  isAnimating: false,
  wallOpen: false,
  petalBaseAngles: [],
  petalLengths: [],
  petalPoses: [],
  coreLength: 0,
  expandedCard: null
};

const DRAW_EASE = "cubic-bezier(0.23, 1, 0.32, 1)";
const RENDER_CHUNK_SIZE = 24;
const FADE_BATCH_SIZE = 24;
const MAX_CONCURRENT_IMAGE_LOADS = 12;

let mediaObserver = null;
let activeImageLoads = 0;
const imageLoadQueue = [];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sacredEase(progress) {
  if (progress < 0.5) {
    return 4 * progress * progress * progress;
  }
  return 1 - Math.pow(-2 * progress + 2, 3) / 2;
}

function parseRotateAngle(transformValue) {
  const match = /rotate\(([-\d.]+)\)/.exec(transformValue || "");
  return match ? Number.parseFloat(match[1]) : 0;
}

function setPetalTransform(petal, x, y, rotate, scale = 1) {
  petal.setAttribute(
    "transform",
    `translate(${x.toFixed(3)} ${y.toFixed(3)}) rotate(${rotate.toFixed(3)}) scale(${scale.toFixed(3)})`
  );
}

function animatePetalTransform(petal, fromPose, toPose, duration = 560) {
  return new Promise((resolve) => {
    const startTime = performance.now();

    const step = (timestamp) => {
      const elapsed = timestamp - startTime;
      const linear = Math.min(elapsed / duration, 1);
      const eased = sacredEase(linear);

      const x = fromPose.x + (toPose.x - fromPose.x) * eased;
      const y = fromPose.y + (toPose.y - fromPose.y) * eased;
      const rotate = fromPose.rotate + (toPose.rotate - fromPose.rotate) * eased;
      const scale = fromPose.scale + (toPose.scale - fromPose.scale) * eased;

      setPetalTransform(petal, x, y, rotate, scale);

      if (linear < 1) {
        requestAnimationFrame(step);
      } else {
        resolve();
      }
    };

    requestAnimationFrame(step);
  });
}

function getStrokeLength(target) {
  if (!target) {
    return 1200;
  }

  if (typeof target.getTotalLength === "function") {
    return Math.max(target.getTotalLength(), 300);
  }

  if (typeof target.getComputedTextLength === "function") {
    return Math.max(target.getComputedTextLength() * 1.35, 420);
  }

  return 1200;
}

function animateDraw(target, duration, delay = 0) {
  return new Promise((resolve) => {
    if (!target || typeof target.animate !== "function") {
      setTimeout(resolve, duration + delay);
      return;
    }

    const length = getStrokeLength(target);
    target.style.strokeDasharray = String(length);
    target.style.strokeDashoffset = String(length);

    const animation = target.animate(
      [
        { strokeDashoffset: length },
        { strokeDashoffset: 0 }
      ],
      {
        duration,
        delay,
        easing: DRAW_EASE,
        fill: "forwards"
      }
    );

    animation.finished
      .then(() => {
        target.classList.add("revealed");
        resolve();
      })
      .catch(() => resolve());
  });
}

function ensureVideoLoaded(video) {
  if (!video || video.dataset.loaded === "1") {
    return;
  }

  video.src = video.dataset.src || "";
  video.dataset.loaded = "1";
}

function primeVideoPreview(video, card) {
  if (!video || video.dataset.previewed === "1") {
    return;
  }

  video.dataset.previewed = "1";
  video.preload = "metadata";
  if (!video.src) {
    video.src = video.dataset.src || "";
  }

  const handleError = () => {
    if (card) {
      card.classList.add("broken");
    }
  };

  const handleLoadedMetadata = () => {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const targetTime = duration > 0 ? Math.min(0.1, Math.max(0, duration - 0.01)) : 0.01;
    try {
      video.currentTime = targetTime;
    } catch (_error) {
    }
  };

  const handleSeeked = () => {
    video.pause();
  };

  video.addEventListener("loadedmetadata", handleLoadedMetadata, { once: true });
  video.addEventListener("seeked", handleSeeked, { once: true });
  video.addEventListener("error", handleError, { once: true });
}

function queueImageLoad(image, card) {
  if (!image || image.dataset.loaded === "1" || image.dataset.queued === "1") {
    return;
  }

  image.dataset.queued = "1";
  imageLoadQueue.push({ image, card });
  pumpImageLoadQueue();
}

function pumpImageLoadQueue() {
  while (activeImageLoads < MAX_CONCURRENT_IMAGE_LOADS && imageLoadQueue.length > 0) {
    const next = imageLoadQueue.shift();
    if (!next || !next.image || next.image.dataset.loaded === "1") {
      continue;
    }

    const { image, card } = next;
    activeImageLoads += 1;

    const finish = () => {
      image.dataset.loaded = "1";
      image.dataset.queued = "0";
      activeImageLoads = Math.max(activeImageLoads - 1, 0);
      pumpImageLoadQueue();
    };

    image.addEventListener("load", finish, { once: true });
    image.addEventListener(
      "error",
      () => {
        const fullSrc = image.dataset.full || "";
        const currentQueueSrc = image.dataset.src || "";
        const canFallbackToFull = Boolean(fullSrc) && currentQueueSrc !== fullSrc;

        if (canFallbackToFull) {
          image.dataset.src = fullSrc;
          image.dataset.loaded = "0";
          image.dataset.queued = "0";
          activeImageLoads = Math.max(activeImageLoads - 1, 0);
          queueImageLoad(image, card);
          return;
        }

        if (card) {
          card.classList.add("broken");
        }
        finish();
      },
      { once: true }
    );

    image.src = image.dataset.src || "";
  }
}

function setupMediaObserver() {
  if (mediaObserver || !wallGrid) {
    return;
  }

  mediaObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          return;
        }

        const card = entry.target;
        if (!(card instanceof HTMLElement)) {
          return;
        }

        if (card.dataset.kind === "image") {
          const image = card.querySelector("img");
          queueImageLoad(image, card);
        } else if (card.dataset.kind === "video") {
          const video = card.querySelector("video");
          primeVideoPreview(video, card);
        }
      });
    },
    {
      root: wallGrid,
      rootMargin: "260px",
      threshold: 0.01
    }
  );
}

function primeFlowerStrokes() {
  if (!flowerEnabled) {
    return;
  }

  if (state.petalBaseAngles.length === 0) {
    state.petalBaseAngles = petals.map((petal) => parseRotateAngle(petal.getAttribute("transform")));
  }

  state.petalLengths = petals.map((petal, index) => {
    const baseAngle = state.petalBaseAngles[index] || 0;
    const length = petal.getTotalLength();

    setPetalTransform(petal, 0, 0, baseAngle, 1);
    petal.style.strokeDasharray = String(length);
    petal.style.strokeDashoffset = String(length);
    petal.classList.remove("visible", "interactive", "faded", "hidden");

    state.petalPoses[index] = { x: 0, y: 0, rotate: baseAngle, scale: 1 };
    return length;
  });

  state.coreLength = coreRing.getTotalLength();
  coreRing.style.strokeDasharray = String(state.coreLength);
  coreRing.style.strokeDashoffset = String(state.coreLength);
  coreRing.classList.remove("visible", "interactive");
}

async function drawFlower() {
  if (!flowerEnabled) {
    return;
  }

  const coreLength = state.coreLength || coreRing.getTotalLength();
  coreRing.style.strokeDasharray = String(coreLength);
  coreRing.style.strokeDashoffset = String(coreLength);
  coreRing.classList.add("visible");

  await coreRing
    .animate(
      [
        { strokeDashoffset: coreLength },
        { strokeDashoffset: 0 }
      ],
      {
        duration: 1700,
        easing: DRAW_EASE,
        fill: "forwards"
      }
    )
    .finished;

  for (let index = 0; index < petals.length; index += 1) {
    const petal = petals[index];
    const length = state.petalLengths[index] || petal.getTotalLength();
    petal.style.strokeDasharray = String(length);
    petal.style.strokeDashoffset = String(length);
    petal.classList.add("visible");

    await petal
      .animate(
        [
          { strokeDashoffset: length },
          { strokeDashoffset: 0 }
        ],
        {
          duration: 860,
          easing: DRAW_EASE,
          fill: "forwards"
        }
      )
      .finished;
  }

  state.flowerReady = true;
  petals.forEach((petal) => petal.classList.add("interactive"));
  coreRing.classList.add("interactive");
  flowerWrap.classList.add("ready");
}

async function runPetalLineup() {
  if (!flowerEnabled) {
    return;
  }

  const spacing = 122;
  const rowY = 174;
  const rowScale = 0.54;
  const firstX = -spacing * ((petals.length - 1) / 2);

  for (let index = 0; index < petals.length; index += 1) {
    const petal = petals[index];
    const fromPose = state.petalPoses[index];
    const toPose = {
      x: firstX + spacing * index,
      y: rowY,
      rotate: 0,
      scale: rowScale
    };

    await animatePetalTransform(petal, fromPose, toPose, 520);
    state.petalPoses[index] = toPose;
    await wait(56);
  }
}

async function movePetalsToTop() {
  if (!flowerEnabled) {
    return;
  }

  const spacing = 92;
  const rowY = -216;
  const rowScale = 0.4;
  const firstX = -spacing * ((petals.length - 1) / 2);

  coreRing
    .animate(
      [
        { opacity: 1 },
        { opacity: 0 }
      ],
      {
        duration: 480,
        easing: DRAW_EASE,
        fill: "forwards"
      }
    )
    .finished.catch(() => {});

  const jobs = petals.map((petal, index) => {
    const fromPose = state.petalPoses[index];
    const toPose = {
      x: firstX + spacing * index,
      y: rowY,
      rotate: 0,
      scale: rowScale
    };

    return wait(index * 36).then(async () => {
      await animatePetalTransform(petal, fromPose, toPose, 760);
      state.petalPoses[index] = toPose;
    });
  });

  await Promise.all(jobs);
  document.body.classList.add("petals-top");
}

function shuffle(array) {
  const copy = [...array];

  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy;
}

function hashToUnit(value) {
  const str = String(value || "");
  let hash = 2166136261;

  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) / 4294967295;
}

function pickWallSize(photo, index) {
  const basis = `${photo.src || ""}|${photo.kind || ""}|${index}`;
  const roll = hashToUnit(basis);

  if (photo.kind === "video") {
    if (roll < 0.1) {
      return "size-2x1";
    }
    return "";
  }

  if (roll < 0.08) {
    return "size-2x2";
  }
  if (roll < 0.2) {
    return "size-2x1";
  }
  if (roll < 0.3) {
    return "size-1x2";
  }

  return "";
}

function applyWallCardStyle(card, photo, index) {
  const base = `${photo.src || ""}|${photo.kind || ""}|${index}`;
  const tilt = (hashToUnit(`${base}|tilt`) - 0.5) * 3.4;
  const floatX = (hashToUnit(`${base}|x`) - 0.5) * 8;
  const floatY = (hashToUnit(`${base}|y`) - 0.5) * 10;
  const shadowY = Math.round(10 + hashToUnit(`${base}|sy`) * 10);
  const shadowBlur = Math.round(18 + hashToUnit(`${base}|sb`) * 18);

  card.style.setProperty("--tilt", `${tilt.toFixed(2)}deg`);
  card.style.setProperty("--float-x", `${floatX.toFixed(1)}px`);
  card.style.setProperty("--float-y", `${floatY.toFixed(1)}px`);
  card.style.setProperty("--shadow-y", `${shadowY}px`);
  card.style.setProperty("--shadow-blur", `${shadowBlur}px`);
}



function toggleCardExpanded(card) {
  const collapse = (target) => {
    const video = target.querySelector("video");
    if (video) {
      video.pause();
    }
    target.classList.remove("expanded");
  };

  if (state.expandedCard === card) {
    collapse(card);
    state.expandedCard = null;
    return;
  }

  if (state.expandedCard) {
    collapse(state.expandedCard);
  }

  if (card.dataset.kind === "video") {
    const video = card.querySelector("video");
    ensureVideoLoaded(video);
    video?.play().catch(() => {});
  } else if (card.dataset.kind === "image") {
    const image = card.querySelector("img");
    if (image && image.dataset.full && image.src !== image.dataset.full) {
      image.src = image.dataset.full;
      image.dataset.fullLoaded = "1";
      image.fetchPriority = "high";
    }
  }

  card.classList.add("expanded");
  state.expandedCard = card;
  card.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
}

function createWallCard(photo, index) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "wall-card";
  const sizeClass = pickWallSize(photo, index);
  if (sizeClass) {
    card.classList.add(sizeClass);
  }
  applyWallCardStyle(card, photo, index);
  card.style.setProperty("--batch-delay", `${Math.floor(index / FADE_BATCH_SIZE) * 120}ms`);
  card.setAttribute("aria-label", `Open media ${index + 1}`);
  card.dataset.kind = photo.kind;

  if (photo.kind === "video") {
    const video = document.createElement("video");
    video.playsInline = true;
    video.muted = true;
    video.loop = true;
    video.preload = "metadata";
    video.disablePictureInPicture = true;
    video.dataset.src = photo.src;
    if (photo.thumb) {
      video.poster = photo.thumb;
    }
    card.classList.add("video-card");

    card.addEventListener("mouseenter", () => {
      ensureVideoLoaded(video);
      video.play().catch(() => {});
    });

    card.addEventListener("mouseleave", () => {
      video.pause();
    });

    video.addEventListener("error", () => card.classList.add("broken"));
    card.appendChild(video);
  } else {
    const image = document.createElement("img");
    image.dataset.src = photo.thumb || photo.src;
    image.dataset.full = photo.src;
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.fetchPriority = "low";
    image.addEventListener("error", () => card.classList.add("broken"));
    card.appendChild(image);
  }

  card.addEventListener("click", () => toggleCardExpanded(card));

  if (mediaObserver) {
    mediaObserver.observe(card);
  }

  return card;
}

function buildPhotoWall() {
  wallGrid.innerHTML = "";
  state.expandedCard = null;

  if (photos.length === 0) {
    const empty = document.createElement("div");
    empty.className = "wall-empty";
    empty.textContent = "No supported media files found in /photos";
    wallGrid.appendChild(empty);
    return;
  }

  const randomized = shuffle(photos);
  let cursor = 0;

  const appendChunk = () => {
    const fragment = document.createDocumentFragment();
    const freshCards = [];
    const limit = Math.min(cursor + RENDER_CHUNK_SIZE, randomized.length);

    for (let index = cursor; index < limit; index += 1) {
      const card = createWallCard(randomized[index], index);
      freshCards.push(card);
      fragment.appendChild(card);
    }

    wallGrid.appendChild(fragment);

    requestAnimationFrame(() => {
      freshCards.forEach((card) => card.classList.add("visible"));
    });

    cursor = limit;
    if (cursor < randomized.length) {
      setTimeout(appendChunk, 16);
    }
  };

  appendChunk();
}

function openPhotoWallInline() {
  if (state.wallOpen) {
    return;
  }

  buildPhotoWall();
  state.wallOpen = true;
  document.body.classList.add("wall-open");
}

function setPlaylistCollapsed(shouldCollapse) {
  if (!playlistPanel) {
    return;
  }

  playlistPanel.classList.toggle("collapsed", shouldCollapse);
  document.body.classList.toggle("playlist-expanded", !shouldCollapse);
  const toggle = playlistPanel.querySelector(".playlist-toggle");
  if (toggle) {
    toggle.textContent = shouldCollapse ? "Expand" : "Collapse";
    toggle.setAttribute("aria-expanded", String(!shouldCollapse));
  }
}

function setupSpotifyPlaylist() {
  if (!playlistPanel) {
    return;
  }

  const playlistId = normalizePlaylistId(playlistPanel.dataset.playlistId);
  const embed = playlistPanel.querySelector(".playlist-embed");
  const openLink = playlistPanel.querySelector(".playlist-open");
  const placeholder = playlistPanel.querySelector(".playlist-placeholder");
  const toggle = playlistPanel.querySelector(".playlist-toggle");

  if (!playlistId) {
    playlistPanel.classList.add("playlist-empty");
    if (embed) {
      embed.removeAttribute("src");
    }
    setPlaylistCollapsed(true);
    return;
  }

  const embedUrl = `https://open.spotify.com/embed/playlist/${playlistId}`;
  const openUrl = `https://open.spotify.com/playlist/${playlistId}`;

  playlistPanel.classList.remove("playlist-empty");
  if (embed) {
    embed.src = embedUrl;
  }
  if (openLink) {
    openLink.href = openUrl;
  }
  if (placeholder) {
    placeholder.remove();
  }

  setPlaylistCollapsed(false);

  if (toggle) {
    toggle.addEventListener("click", () => {
      const next = !playlistPanel.classList.contains("collapsed");
      setPlaylistCollapsed(next);
    });
  }
}

function attachEvents() {
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.expandedCard) {
      state.expandedCard.classList.remove("expanded");
      state.expandedCard = null;
    }
  });

  photoWall.addEventListener("click", (event) => {
    if (event.target === photoWall && state.expandedCard) {
      state.expandedCard.classList.remove("expanded");
      state.expandedCard = null;
    }
  });
}

async function runIntro() {
  if (document.fonts && typeof document.fonts.ready === "object") {
    try {
      await Promise.race([document.fonts.ready, wait(1400)]);
    } catch (_error) {
    }
  }

  await wait(220);
  document.body.classList.remove("booting");

  await animateDraw(nameStroke, 6200, 200);
  nameStroke.classList.add("glow");

  await Promise.all([
    animateDraw(arabicMessage, 6200, 260),
    animateDraw(englishMessage, 6200, 260)
  ]);

  document.body.classList.add("intro-finished");

  if (!flowerEnabled) {
    await wait(380);
    openPhotoWallInline();
    return;
  }

  await wait(1200);
  document.body.classList.add("flower-entered");
  await wait(250);

  await drawFlower();
  await wait(220);
  await runPetalLineup();
  await wait(240);
  await movePetalsToTop();
  await wait(180);
  openPhotoWallInline();
}

async function init() {
  primeFlowerStrokes();
  setupMediaObserver();
  setupSpotifyPlaylist();
  attachEvents();
  await runIntro();
}

init();
