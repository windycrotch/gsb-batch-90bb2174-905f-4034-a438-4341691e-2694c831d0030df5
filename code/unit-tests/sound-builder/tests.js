// Microtonal Fabric
//
// Copyright (c) Sergey A Kryukov, 2017-2021
//
// http://www.SAKryukov.org
// http://www.codeproject.com/Members/SAKryukov
// https://github.com/SAKryukov
// https://github.com/SAKryukov/microtonal-fabric

// Automated tests for repeatable, recoverable instrument application:
//   - normal apply (graph topology, master depth, modulator frequencies)
//   - full modulator replacement on re-apply (no stacking, no residue)
//   - filter enable/disable round-trip and repopulation connectivity
//   - rollback on failed load / failed apply
//   - rapid consecutive applies and the load-then-apply race
//
// The tests assert on audio node connections and data state
// (recorded by mock-audio.js), not only on function calls.

"use strict";

(() => {

    // ---------- tiny test framework ----------

    const suite = [];
    const test = (name, body) => suite.push({ name, body });
    const assert = (condition, message) => {
        if (!condition) throw new Error(message || "assertion failed");
    };
    const assertEqual = (actual, expected, message) => {
        if (actual !== expected)
            throw new Error(`${message}: expected ${expected}, got ${actual}`);
    };
    const assertClose = (actual, expected, message) => {
        if (Math.abs(actual - expected) > 1e-6)
            throw new Error(`${message}: expected ${expected}, got ${actual}`);
    };
    const assertThrows = (fn, message) => {
        let threw = false;
        try { fn(); } catch (ex) { threw = true; }
        if (!threw) throw new Error(`${message}: expected an exception`);
    };

    // ---------- graph introspection on top of the mock ----------

    const mainOscillators = context =>
        context.allNodes.filter(node => node.kind == "oscillator" && node.createdWithOptions);
    const modulatorOscillators = context =>
        context.allNodes.filter(node => node.kind == "oscillator" && !node.createdWithOptions);
    const fmEnvelopeNode = (context, mainOscillator) =>
        context.feedersOf(mainOscillator.frequency)[0];
    const amEnvelopeNodes = context => {
        const result = new Set();
        for (const node of context.allNodes)
            if (node.kind == "gain")
                for (const feeder of context.feedersOf(node.gain))
                    result.add(feeder);
        return [...result];
    };
    // the master-depth node shared by all tones is the instrument-level (absolute) one:
    const masterDepthKind = (context, masterNode, envelopeNodes) =>
        envelopeNodes.filter(envelope => context.isConnected(masterNode, envelope)).length > 1
            ? "instrument" : "tone";
    const modulatorsInto = (context, masterNode) =>
        context.feedersOf(masterNode).map(depthNode => ({
            depthNode, oscillator: context.feedersOf(depthNode)[0],
        }));
    const findMasterGain = context =>
        context.allNodes.find(node => node.kind == "gain" &&
            context.downstream(node).some(next => next === context.destination || next.kind == "biquad"));
    const biquads = context => context.allNodes.filter(node => node.kind == "biquad");

    const toneFrequencies = [440, 440 * Math.pow(2, 1 / 12), 440 * Math.pow(2, 2 / 12)];

    const createInstrument = () => new Instrument({ first: 0, last: 2, startingFrequency: 440 }, 12);

    const makeModel = options => {
        const model = JSON.parse(JSON.stringify(defaultInstrument));
        model.header = {
            format: "Sound Builder", version: "0.2.2", formatVersion: "3.1.0",
            author: "", instrumentName: options.name || "test-instrument",
        };
        const modulation = specification => ({ masterDepth: specification.depth, modes: specification.modes.slice() });
        model.frequencyModulation.absoluteFrequency = modulation(options.fmAbs);
        model.frequencyModulation.relativeFrequency = modulation(options.fmRel);
        model.amplitudeModulation.absoluteFrequency = modulation(options.amAbs);
        model.amplitudeModulation.relativeFrequency = modulation(options.amRel);
        model.filter = model.filter.map((filter, index) =>
            Object.assign(filter, { present: index < options.filterCount }));
        return model;
    }; //makeModel

    const fullOptions = overrides => Object.assign({
        fmAbs: { depth: 0.3, modes: [{ frequency: 5, depth: 40 }] },
        fmRel: { depth: 0.4, modes: [{ frequency: 2, depth: 50 }] },
        amAbs: { depth: 0.6, modes: [{ frequency: 6, depth: 30 }] },
        amRel: { depth: 0.7, modes: [{ frequency: 3, depth: 20 }] },
        filterCount: 2,
    }, overrides);
    const fullModel = overrides => makeModel(fullOptions(overrides));

    // checks the whole modulation topology for the current state of an instrument
    const assertModulationState = (instrument, expectation, message) => {
        const context = instrument.context;
        const mains = mainOscillators(context);
        assertEqual(mains.length, 3, `${message}: main oscillator count`);
        const fmEnvelopes = mains.map(oscillator => fmEnvelopeNode(context, oscillator));
        const amEnvelopes = amEnvelopeNodes(context);
        assertEqual(amEnvelopes.length, 3, `${message}: AM envelope node count`);
        const checkSide = (envelopeNodes, absolute, relative, sideName) => {
            for (let index = 0; index < envelopeNodes.length; ++index) {
                const masters = context.feedersOf(envelopeNodes[index]);
                assertEqual(masters.length, 2,
                    `${message}: ${sideName} master-depth node count feeding tone ${index}`);
                for (let master of masters) {
                    const kind = masterDepthKind(context, master, envelopeNodes);
                    const spec = kind == "instrument" ? absolute : relative;
                    assertClose(master.gain.value, spec.depth,
                        `${message}: ${sideName} ${kind}-level master depth, tone ${index}`);
                    const modulators = modulatorsInto(context, master);
                    assertEqual(modulators.length, spec.modes.length,
                        `${message}: ${sideName} ${kind}-level modulator count, tone ${index}`);
                    for (let modeIndex = 0; modeIndex < spec.modes.length; ++modeIndex) {
                        const modulator = modulators[modeIndex];
                        assert(!!modulator.oscillator,
                            `${message}: ${sideName} modulator ${modeIndex} of tone ${index} has no oscillator`);
                        assert(!modulator.oscillator.stopped,
                            `${message}: ${sideName} modulator ${modeIndex} of tone ${index} is stopped`);
                        const expectedFrequency = kind == "instrument"
                            ? spec.modes[modeIndex].frequency
                            : spec.modes[modeIndex].frequency * toneFrequencies[index];
                        assertClose(modulator.oscillator.frequency.value, expectedFrequency,
                            `${message}: ${sideName} ${kind}-level modulator ${modeIndex} frequency, tone ${index}`);
                        assertClose(modulator.depthNode.gain.value, spec.modes[modeIndex].depth,
                            `${message}: ${sideName} modulator ${modeIndex} depth, tone ${index}`);
                    } //loop modes
                } //loop masters
            } //loop tones
        }; //checkSide
        checkSide(fmEnvelopes, expectation.fmAbs, expectation.fmRel, "FM");
        checkSide(amEnvelopes, expectation.amAbs, expectation.amRel, "AM");
    }; //assertModulationState

    const assertNoStoppedModulatorConnected = (instrument, message) => {
        const context = instrument.context;
        for (let oscillator of modulatorOscillators(context))
            if (oscillator.stopped)
                assertEqual(context.downstream(oscillator).length, 0,
                    `${message}: a stopped modulator oscillator is still connected`);
    };

    const assertFilterChain = (instrument, expectedFilterCount, expectedEnabled, message) => {
        const context = instrument.context;
        const masterGain = findMasterGain(context);
        assert(!!masterGain, `${message}: master gain node not found`);
        const directConnection = context.isConnected(masterGain, context.destination);
        const firstHopIsFilter = context.downstream(masterGain).some(node => node.kind == "biquad");
        for (let oscillator of mainOscillators(context))
            assert(context.pathExists(oscillator, context.destination),
                `${message}: a main oscillator cannot reach the destination (silence)`);
        if (expectedEnabled && expectedFilterCount > 0) {
            assert(firstHopIsFilter, `${message}: filter chain enabled, but master gain does not feed a filter`);
            assert(!directConnection, `${message}: filter chain enabled, but master gain bypasses it directly`);
            assert(context.pathExists(masterGain, context.destination),
                `${message}: filter chain enabled, but it does not reach the destination`);
        } else {
            assert(directConnection, `${message}: filters bypassed, but master gain is not connected to the destination`);
            assert(!firstHopIsFilter, `${message}: filters bypassed, but master gain still feeds a filter`);
        } //if
    }; //assertFilterChain

    const usage = soundDefinitionSet.playControl.usage;

    // ---------- tests ----------

    test("normal apply: graph topology, master depth, modulator frequencies", () => {
        const instrument = createInstrument();
        instrument.data = fullModel();
        assertModulationState(instrument, fullOptions(), "first apply");
        assertFilterChain(instrument, 2, true, "first apply");
    });

    test("re-apply fully replaces modulators: nothing stacks, nothing is left over", () => {
        const instrument = createInstrument();
        instrument.data = fullModel();
        const context = instrument.context;
        const oscillatorsAfterFirstApply = modulatorOscillators(context).length;
        assert(oscillatorsAfterFirstApply > 0, "first apply should create modulators");
        const secondOptions = fullOptions({
            fmAbs: { depth: 0.5, modes: [{ frequency: 7, depth: 20 }, { frequency: 9, depth: 10 }] },
            fmRel: { depth: 0.5, modes: [{ frequency: 4, depth: 20 }, { frequency: 5, depth: 10 }] },
            amAbs: { depth: 0.5, modes: [] },
            amRel: { depth: 0.5, modes: [] },
        });
        instrument.data = makeModel(secondOptions);
        assertModulationState(instrument, secondOptions, "second apply");
        // every modulator of the first apply is stopped and disconnected:
        const stopped = modulatorOscillators(context).filter(oscillator => oscillator.stopped);
        assertEqual(stopped.length, oscillatorsAfterFirstApply,
            "all modulators of the first apply must be stopped after the second apply");
        assertNoStoppedModulatorConnected(instrument, "second apply");
    });

    test("master depth survives re-application and respects the enable state", () => {
        const instrument = createInstrument();
        instrument.data = fullModel();
        // disable FM and AM, then re-apply with a different master depth:
        instrument.playWith(usage.frequencyModulation, false);
        instrument.playWith(usage.amplitudeModulation, false);
        assertEqual(instrument.frequencyModulationEnable, false, "FM enable getter after disabling");
        assertEqual(instrument.amplitudeModulationEnable, false, "AM enable getter after disabling");
        const deeper = fullModel({
            fmAbs: { depth: 0.9, modes: [{ frequency: 5, depth: 40 }] },
            fmRel: { depth: 0.9, modes: [{ frequency: 2, depth: 50 }] },
            amAbs: { depth: 0.9, modes: [{ frequency: 6, depth: 30 }] },
            amRel: { depth: 0.9, modes: [{ frequency: 3, depth: 20 }] },
        });
        instrument.data = deeper;
        // re-application must not resurrect modulation that the user switched off:
        const context = instrument.context;
        const mains = mainOscillators(context);
        const fmEnvelopes = mains.map(oscillator => fmEnvelopeNode(context, oscillator));
        for (let envelope of fmEnvelopes)
            for (let master of context.feedersOf(envelope))
                assertClose(master.gain.value, 0, "FM master depth while FM is disabled and re-applied");
        for (let envelope of amEnvelopeNodes(context))
            for (let master of context.feedersOf(envelope))
                assertClose(master.gain.value, 0, "AM master depth while AM is disabled and re-applied");
        // re-enabling restores the master depth of the last applied data:
        instrument.playWith(usage.frequencyModulation, true);
        instrument.playWith(usage.amplitudeModulation, true);
        assertEqual(instrument.frequencyModulationEnable, true, "FM enable getter after re-enabling");
        for (let envelope of fmEnvelopes)
            for (let master of context.feedersOf(envelope))
                assertClose(master.gain.value, 0.9, "FM master depth after re-enabling");
        for (let envelope of amEnvelopeNodes(context))
            for (let master of context.feedersOf(envelope))
                assertClose(master.gain.value, 0.9, "AM master depth after re-enabling");
    });

    test("filter toggle round-trip keeps the instrument sounding", () => {
        const instrument = createInstrument();
        instrument.data = fullModel({ filterCount: 2 });
        assertFilterChain(instrument, 2, true, "filters enabled");
        instrument.playWith(usage.filters, false);
        assertFilterChain(instrument, 2, false, "filters disabled");
        instrument.playWith(usage.filters, true);
        assertFilterChain(instrument, 2, true, "filters re-enabled");
    });

    test("filter chain stays connected when repopulated while enabled", () => {
        const instrument = createInstrument();
        instrument.data = fullModel({ filterCount: 2 });
        instrument.data = fullModel({ filterCount: 3 });
        assertFilterChain(instrument, 3, true, "re-applied with 3 filters while enabled");
        // exactly 3 filters sit on the connected path; replaced ones are disconnected:
        const context = instrument.context;
        let count = 0;
        let node = findMasterGain(context);
        while (context.downstream(node).length > 0) {
            const next = context.downstream(node)[0];
            if (next === context.destination) break;
            assert(next.kind == "biquad", "only filters may sit between master gain and destination");
            ++count;
            node = next;
        } //loop
        assertEqual(count, 3, "connected filter count after repopulation");
        assert(context.pathExists(node, context.destination), "the filter chain reaches the destination");
        instrument.data = fullModel({ filterCount: 0 });
        assertFilterChain(instrument, 0, true, "re-applied with no filters while enabled");
    });

    test("filter chain repopulated while disabled restores exactly on re-enable", () => {
        const instrument = createInstrument();
        instrument.data = fullModel({ filterCount: 2 });
        instrument.playWith(usage.filters, false);
        instrument.data = fullModel({ filterCount: 3 });
        assertFilterChain(instrument, 3, false, "re-applied while disabled");
        instrument.playWith(usage.filters, true);
        assertFilterChain(instrument, 3, true, "re-enabled after re-apply");
    });

    test("disabling an empty filter chain is remembered when filters arrive later", () => {
        const instrument = createInstrument();
        instrument.data = fullModel({ filterCount: 0 });
        instrument.playWith(usage.filters, false); // empty chain: nothing to rewire, but the state must stick
        instrument.data = fullModel({ filterCount: 2 });
        assertFilterChain(instrument, 2, false, "filters arrived while disabled");
        instrument.playWith(usage.filters, true);
        assertFilterChain(instrument, 2, true, "filters enabled afterwards");
    });

    test("failed load is rejected by the parser and changes no state", () => {
        // malformed JSON:
        assertThrows(() => instrumentModelIO.parseInstrumentFile("{ not json", "3.1.0"),
            "malformed JSON");
        // missing header:
        assertThrows(() => instrumentModelIO.parseInstrumentFile('{"oscillator":{}}', "3.1.0"),
            "missing header");
        // invalid format version:
        assertThrows(() => instrumentModelIO.parseInstrumentFile(
            JSON.stringify({ header: { formatVersion: "not-a-number" } }), "3.1.0"),
            "invalid format version");
        // format version too high:
        assertThrows(() => instrumentModelIO.parseInstrumentFile(
            JSON.stringify({ header: { formatVersion: "999.0" } }), "3.1.0"),
            "format version too high");
        // acceptable versions:
        const model = instrumentModelIO.parseInstrumentFile(
            JSON.stringify({ header: { formatVersion: "3.1.0" } }), "3.1.0");
        assert(!!model, "acceptable version must parse");
        // a failed load leaves the current model reference untouched:
        const singleton = { model: { header: { instrumentName: "previous" } } };
        let loadedModel;
        try {
            loadedModel = instrumentModelIO.parseInstrumentFile("{ broken", "3.1.0");
            singleton.model = loadedModel;
        } catch (ex) { /* the load failed: nothing is assigned */ }
        assertEqual(singleton.model.header.instrumentName, "previous",
            "the current model must survive a failed load");
    });

    test("failed apply keeps the previously applied instrument state", () => {
        const instrument = createInstrument();
        const good = fullModel();
        instrument.data = good;
        const context = instrument.context;
        const corrupt = variants => {
            const corrupted = JSON.parse(JSON.stringify(good));
            variants(corrupted);
            return corrupted;
        };
        const badDatasets = [
            corrupt(model => delete model.frequencyModulation),
            corrupt(model => delete model.amplitudeModulation.relativeFrequency),
            corrupt(model => model.frequencyModulation.absoluteFrequency = { masterDepth: 1 }),
            corrupt(model => model.gainEnvelope = {}),
            corrupt(model => model.filter = null),
            corrupt(model => delete model.oscillator),
        ];
        for (let bad of badDatasets)
            assertThrows(() => instrument.data = bad, "applying a malformed dataset");
        // after all the failures the instrument is exactly the last good apply:
        assertModulationState(instrument, fullOptions(), "state after failed applies");
        assertFilterChain(instrument, 2, true, "state after failed applies");
        assertNoStoppedModulatorConnected(instrument, "state after failed applies");
    });

    test("rapid consecutive applies: the last one wins, no residue of earlier ones", () => {
        const instrument = createInstrument();
        const first = fullModel({
            fmAbs: { depth: 0.1, modes: [{ frequency: 3, depth: 10 }] },
            fmRel: { depth: 0.1, modes: [{ frequency: 3, depth: 10 }] },
            filterCount: 1,
        });
        const second = fullModel({
            fmAbs: { depth: 0.2, modes: [{ frequency: 4, depth: 20 }, { frequency: 6, depth: 30 }] },
            fmRel: { depth: 0.2, modes: [{ frequency: 4, depth: 20 }] },
            filterCount: 3,
        });
        const third = fullModel({
            fmAbs: { depth: 0.8, modes: [{ frequency: 11, depth: 70 }] },
            fmRel: { depth: 0.8, modes: [{ frequency: 7, depth: 60 }] },
            amAbs: { depth: 0.8, modes: [{ frequency: 13, depth: 50 }] },
            amRel: { depth: 0.8, modes: [{ frequency: 8, depth: 40 }] },
            filterCount: 2,
        });
        // rapid-fire applies with no settling time in between:
        instrument.data = first;
        instrument.data = second;
        instrument.data = third;
        assertModulationState(instrument, fullOptions({
            fmAbs: { depth: 0.8, modes: [{ frequency: 11, depth: 70 }] },
            fmRel: { depth: 0.8, modes: [{ frequency: 7, depth: 60 }] },
            amAbs: { depth: 0.8, modes: [{ frequency: 13, depth: 50 }] },
            amRel: { depth: 0.8, modes: [{ frequency: 8, depth: 40 }] },
        }), "the last of three rapid applies");
        assertFilterChain(instrument, 2, true, "the last of three rapid applies");
        assertNoStoppedModulatorConnected(instrument, "the last of three rapid applies");
    });

    test("load then immediately apply: the loaded data wins the race", () => {
        // simulates main.js: a loaded model is applied deferred (setTimeout),
        // while the user clicks Apply in between
        const viewModel = fullModel({ name: "from-view" });
        const loadedModel = fullModel({ name: "from-file" });
        const singleton = {
            model: viewModel,
            modelToViewCalls: [],
            modelToView() { this.modelToViewCalls.push(this.model); },
        };
        const applied = [];
        const apply = () => applied.push(singleton.model);
        // the user clicks Apply before the deferred load lands:
        apply();
        assertEqual(singleton.model.header.instrumentName, "from-view", "view model applied first");
        // the deferred load application must re-establish the loaded model:
        instrumentModelIO.applyLoadedModel(singleton, loadedModel, apply);
        assertEqual(singleton.model, loadedModel, "loaded model restored after an interleaved apply");
        assertEqual(singleton.modelToViewCalls.length, 1, "modelToView called once");
        assertEqual(singleton.modelToViewCalls[0], loadedModel, "modelToView received the loaded model");
        assertEqual(applied[applied.length - 1], loadedModel, "the last apply uses the loaded model");
    });

    // ---------- runner ----------

    const results = [];
    let failures = 0;
    for (let { name, body } of suite) {
        try {
            body();
            results.push(`PASS: ${name}`);
        } catch (ex) {
            ++failures;
            results.push(`FAIL: ${name}\n    ${ex.message}`);
        } //exception
    } //loop
    const summary = `${suite.length - failures}/${suite.length} tests passed`;
    const report = `${results.join("\n")}\n${summary}`;
    if (typeof document != "undefined") {
        const element = document.createElement("pre");
        element.id = "test-results";
        element.dataset.failures = failures;
        element.textContent = report;
        document.body.appendChild(element);
        document.title = failures == 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`;
    } //if
    if (typeof console != "undefined")
        console.log(report);
    globalThis.__soundBuilderTestResults = { failures, total: suite.length, report };

})();
