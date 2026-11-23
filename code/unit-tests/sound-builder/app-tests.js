// Microtonal Fabric
//
// Copyright (c) Sergey A Kryukov, 2017-2021
//
// http://www.SAKryukov.org
// http://www.codeproject.com/Members/SAKryukov
// https://github.com/SAKryukov
// https://github.com/SAKryukov/microtonal-fabric

// Application-level end-to-end tests: drives the real, unmodified
// SoundBuilder/index.html (loaded in an iframe) with real UI events
// and the real Web Audio API.
//
// Covered:
//   - the application starts and applies the default instrument
//   - a failed load (malformed JSON, too-new format version) keeps
//     the view and the currently applied instrument untouched
//   - load immediately followed by Apply: the loaded instrument wins
//   - rapid consecutive applies end up with the last data
//   - the filter usage toggle round-trip produces no errors

"use strict";

(() => {

    const results = [];
    let failures = 0;
    const test = (name, condition, detail) => {
        if (condition)
            results.push(`PASS: ${name}`);
        else {
            ++failures;
            results.push(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
        } //if
    }; //test

    const frame = document.getElementById("application-frame");
    const finish = () => {
        const summary = `${results.length - failures}/${results.length} tests passed`;
        const element = document.createElement("pre");
        element.id = "test-results";
        element.dataset.failures = failures;
        element.textContent = `${results.join("\n")}\n${summary}`;
        document.body.appendChild(element);
        document.title = failures == 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`;
    }; //finish

    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

    frame.addEventListener("load", async () => {
        try {
            const appWindow = frame.contentWindow;
            const appDocument = frame.contentDocument;
            const exceptionElement = () => appDocument.querySelector("footer p:nth-child(2)");
            const nameElement = () => appDocument.querySelector("header aside p input");
            const applyButton = () => appDocument.querySelector("footer div button:nth-child(2)");
            const loadButton = () => appDocument.querySelector("footer button:first-child");
            const filterButton = () => appDocument.querySelectorAll("header button")[7];

            // start the application (real click on the Start button):
            appDocument.querySelector("#initialize-system > button").click();
            await sleep(200);
            test("application starts without an exception", exceptionElement().textContent == "",
                exceptionElement().textContent);
            const nameAfterStart = nameElement().value;

            // intercept the file dialog of the real Load button
            // (fileIO is a top-level const, so it is reached through the frame's realm):
            const fileIO = appWindow.eval("fileIO");
            let loadHandler = null;
            const originalLoadTextFile = fileIO.loadTextFile;
            fileIO.loadTextFile = handler => { loadHandler = handler; };
            loadButton().click();
            fileIO.loadTextFile = originalLoadTextFile;
            test("load button requests a file", !!loadHandler);

            // a malformed file must be rejected without touching the current state:
            loadHandler("broken.json", "{ this is not json");
            await sleep(100);
            test("malformed JSON reports an error", exceptionElement().textContent != "");
            test("malformed JSON keeps the current instrument name",
                nameElement().value == nameAfterStart,
                `expected "${nameAfterStart}", got "${nameElement().value}"`);

            // a file from a too-new format version must be rejected the same way:
            loadHandler("too-new.json", JSON.stringify(
                { header: { formatVersion: "999.0", instrumentName: "too-new" } }));
            await sleep(100);
            test("too-new format version reports an error", exceptionElement().textContent != "");
            test("too-new format version keeps the current instrument name",
                nameElement().value == nameAfterStart,
                `expected "${nameAfterStart}", got "${nameElement().value}"`);

            // a valid load, immediately followed by Apply: the loaded instrument must win:
            const loadedModel = {
                header: { format: "Sound Builder", version: "0.2.2", formatVersion: "3.1.0", author: "", instrumentName: "loaded-instrument" },
                gainCompensation: { masterGain: 1, middleFrequency: 329.628, lowFrequency: 27.5, lowFrequencyCompensationGain: 1, highFrequency: 3951, highFrequencyCompensationGain: 1 },
                oscillator: { type: "triangle", Fourier: [] },
                gainEnvelope: { stages: [], dampingSustain: 0.02 },
                detuneEnvelope: { stages: [], dampingSustain: 0.02 },
                frequencyModulation: {
                    absoluteFrequency: { masterDepth: 0.5, modes: [{ frequency: 6, depth: 30 }] },
                    relativeFrequency: { masterDepth: 0.5, modes: [] },
                    envelope: { stages: [], dampingSustain: 0.02 },
                },
                amplitudeModulation: {
                    absoluteFrequency: { masterDepth: 1, modes: [] },
                    relativeFrequency: { masterDepth: 1, modes: [] },
                    envelope: { stages: [], dampingSustain: 0.02 },
                },
                filter: [{ present: true, index: 0, type: "lowpass", frequency: 800, Q: 1 }],
            };
            loadHandler("good.json", JSON.stringify(loadedModel));
            applyButton().disabled = false; // simulate pending view edits
            applyButton().click(); // the user applies before the deferred load lands
            await sleep(200);
            test("load followed by immediate apply ends with the loaded instrument",
                nameElement().value == "loaded-instrument",
                `got "${nameElement().value}"`);
            test("no error after load/apply race", exceptionElement().textContent == "",
                exceptionElement().textContent);

            // rapid consecutive applies:
            applyButton().disabled = false;
            applyButton().click();
            applyButton().disabled = false;
            applyButton().click();
            await sleep(100);
            test("rapid consecutive applies produce no error", exceptionElement().textContent == "",
                exceptionElement().textContent);
            test("rapid consecutive applies keep the instrument",
                nameElement().value == "loaded-instrument",
                `got "${nameElement().value}"`);

            // filter usage toggle round-trip:
            filterButton().click();
            await sleep(50);
            filterButton().click();
            await sleep(50);
            test("filter toggle round-trip produces no error", exceptionElement().textContent == "",
                exceptionElement().textContent);

            // FM usage toggle round-trip:
            const fmButton = appDocument.querySelectorAll("header button")[1];
            fmButton.click();
            await sleep(50);
            applyButton().disabled = false;
            applyButton().click(); // re-apply while FM is off
            await sleep(50);
            fmButton.click();
            await sleep(50);
            test("FM toggle with re-apply produces no error", exceptionElement().textContent == "",
                exceptionElement().textContent);
        } catch (ex) {
            ++failures;
            results.push(`FAIL: application-level test run aborted — ${ex.message}`);
        } //exception
        finish();
    });

})();
