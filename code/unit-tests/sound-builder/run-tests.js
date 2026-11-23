// Microtonal Fabric
//
// Copyright (c) Sergey A Kryukov, 2017-2021
//
// http://www.SAKryukov.org
// http://www.codeproject.com/Members/SAKryukov
// https://github.com/SAKryukov
// https://github.com/SAKryukov/microtonal-fabric

// Runs the Sound Builder browser tests in a headless Chrome or Edge:
//   index.html     — sound-engine tests (audio graph connections and data state)
//   app-tests.html — application-level tests (drives the real app in an iframe)
//
// Usage: node run-tests.js
// Exit code 0: all tests passed; 1: failures; 2: no browser found.

"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testPages = ["index.html", "app-tests.html"];

const browserCandidates = [
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const browser = browserCandidates.find(candidate => fs.existsSync(candidate));
if (!browser) {
    console.error("No Chrome/Edge executable found; set CHROME_PATH to a browser executable.");
    process.exit(2);
} //if

const runPage = page => {
    const testPage = `file:///${path.join(__dirname, page).replace(/\\/g, "/")}`;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "sound-builder-tests-"));
    try {
        return execFileSync(browser, [
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            `--user-data-dir=${profile}`,
            "--allow-file-access-from-files",
            "--autoplay-policy=no-user-gesture-required",
            "--virtual-time-budget=20000",
            "--dump-dom",
            testPage,
        ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    } finally {
        fs.rmSync(profile, { recursive: true, force: true });
    } //exception
}; //runPage

let totalFailures = 0;
for (let page of testPages) {
    console.log(`=== ${page} ===`);
    let dom;
    try {
        dom = runPage(page);
    } catch (ex) {
        console.error(`Failed to run the browser: ${ex.message}`);
        process.exit(2);
    } //exception
    const match = dom.match(/<pre id="test-results" data-failures="(\d+)">([\s\S]*?)<\/pre>/);
    if (!match) {
        console.error("Test results not found in the page; the test page failed to load or run.");
        process.exit(2);
    } //if
    const failures = parseInt(match[1]);
    totalFailures += failures;
    const report = match[2]
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    console.log(report);
    console.log("");
} //loop

console.log(totalFailures == 0 ? "ALL TESTS PASSED" : `${totalFailures} TEST(S) FAILED`);
process.exit(totalFailures == 0 ? 0 : 1);
