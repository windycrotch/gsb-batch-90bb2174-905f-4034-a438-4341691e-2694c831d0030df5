/**
 * The page under test. Served by the harness fixture server; it loads the built
 * player bundle and exposes `window.__fixture`, a small driver the Node test uses to
 * create a player, switch sources and read the visible player state.
 */
export const PLAYER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Source switch harness</title>
  <link rel="stylesheet" href="/styles.css" />
  <style>
    html, body { margin: 0; padding: 0; background: #101418; }
    .stack { width: 720px; padding: 16px; }
    .video-js { width: 640px; height: 360px; }
    .vjs-up-next-overlay, .vjs-present-upcoming { display: none !important; }
  </style>
</head>
<body>
  <div class="stack">
    <video id="player" class="video-js" controls preload="auto"></video>
  </div>
  <script src="/dist/index.global.js"></script>
  <script src="/fixture-driver.js"></script>
</body>
</html>`;
