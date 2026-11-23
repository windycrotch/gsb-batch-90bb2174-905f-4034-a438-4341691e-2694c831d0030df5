// Microtonal Fabric
//
// Copyright (c) Sergey A Kryukov, 2017-2021
//
// http://www.SAKryukov.org
// http://www.codeproject.com/Members/SAKryukov
// https://github.com/SAKryukov
// https://github.com/SAKryukov/microtonal-fabric

// Connection-tracking mock of the Web Audio API.
// It mirrors the connect/disconnect semantics of the real API
// (including the rule that duplicate connections are ignored)
// and records the whole graph, so tests can assert on actual
// audio node connections, not only on function calls.
//
// Loading this script replaces the global AudioContext, OscillatorNode,
// GainNode and BiquadFilterNode constructors; it must be loaded before
// the sound engine classes are instantiated (not necessarily before
// the engine scripts themselves).

"use strict";

class MockAudioParam {
    constructor(value) { this.value = value; this.automationEvents = []; }
    setTargetAtTime(value, time, timeConstant) { this.automationEvents.push(["setTargetAtTime", value]); this.value = value; }
    cancelScheduledValues(time) { this.automationEvents.push(["cancelScheduledValues"]); }
    setValueAtTime(value, time) { this.automationEvents.push(["setValueAtTime", value]); this.value = value; }
    linearRampToValueAtTime(value, time) { this.automationEvents.push(["linearRampToValueAtTime", value]); this.value = value; }
    exponentialRampToValueAtTime(value, time) { this.automationEvents.push(["exponentialRampToValueAtTime", value]); this.value = value; }
} //class MockAudioParam

let mockAudioNodeId = 0;
class MockAudioNode {
    constructor(context, kind) {
        this.context = context;
        this.kind = kind;
        this.id = ++mockAudioNodeId;
        if (context) context.allNodes.push(this);
    } //constructor
    connect(destination) {
        if (!destination) throw new Error("connect: destination is not defined");
        // the Web Audio API ignores duplicate connections between the same termini;
        // a Set gives exactly the same behavior:
        this.context._registerConnection(this, destination);
        return destination;
    } //connect
    disconnect() { this.context._unregisterAllConnections(this); }
} //class MockAudioNode

class MockOscillatorNode extends MockAudioNode {
    constructor(context, options) {
        super(context, "oscillator");
        this.frequency = new MockAudioParam(options && options.frequency != undefined ? options.frequency : 440);
        this.detune = new MockAudioParam(0);
        this.type = "sine";
        this.started = false;
        this.stopped = false;
        this.createdWithOptions = options != undefined; // distinguishes main oscillators from modulators
    } //constructor
    start() { this.started = true; }
    stop() { this.stopped = true; }
    setPeriodicWave(wave) { this.periodicWave = wave; }
} //class MockOscillatorNode

class MockGainNode extends MockAudioNode {
    constructor(context, options) {
        super(context, "gain");
        this.gain = new MockAudioParam(options && options.gain != undefined ? options.gain : 1);
    } //constructor
} //class MockGainNode

class MockBiquadFilterNode extends MockAudioNode {
    constructor(context) {
        super(context, "biquad");
        this.type = "lowpass";
        this.frequency = new MockAudioParam(350);
        this.Q = new MockAudioParam(1);
        this.gain = new MockAudioParam(0);
    } //constructor
} //class MockBiquadFilterNode

class MockAudioContext {
    constructor() {
        this.connections = new Map(); // from node -> Set of (node | AudioParam)
        this.allNodes = [];
        this.destination = new MockAudioNode(this, "destination");
        this.currentTime = 0;
    } //constructor
    _registerConnection(from, to) {
        if (!this.connections.has(from)) this.connections.set(from, new Set());
        this.connections.get(from).add(to);
    } //_registerConnection
    _unregisterAllConnections(from) { this.connections.delete(from); }
    createPeriodicWave(real, imag) { return { real, imag }; }
    // introspection helpers for tests:
    downstream(node) { return Array.from(this.connections.get(node) || []); }
    isConnected(from, to) { return this.connections.has(from) && this.connections.get(from).has(to); }
    feedersOf(target) { // nodes with a connection into target (node or AudioParam)
        return this.allNodes.filter(node => this.isConnected(node, target));
    } //feedersOf
    pathExists(from, to) { // audio path through nodes only (AudioParams are sinks)
        const seen = new Set();
        const walk = node => {
            if (node === to) return true;
            if (seen.has(node)) return false;
            seen.add(node);
            for (let next of this.downstream(node))
                if (next instanceof MockAudioNode && walk(next)) return true;
            return false;
        };
        return walk(from);
    } //pathExists
} //class MockAudioContext

// replace the global Web Audio constructors:
globalThis.AudioContext = MockAudioContext;
globalThis.OscillatorNode = MockOscillatorNode;
globalThis.GainNode = MockGainNode;
globalThis.BiquadFilterNode = MockBiquadFilterNode;
