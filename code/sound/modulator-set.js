// Microtonal Fabric
//
// Copyright (c) Sergey A Kryukov, 2017-2021
//
// http://www.SAKryukov.org
// http://www.codeproject.com/Members/SAKryukov
// https://github.com/SAKryukov
// https://github.com/SAKryukov/microtonal-fabric

class ModulatorSet {

    #implementation = { isFmEnabled: true, isAmEnabled: true, fmMasterDepth: 1, amMasterDepth: 1 };

    constructor(audioContext, soundSourceFrequency) {
        if (audioContext)
            this.context = audioContext;
        this.#implementation.soundSourceFrequency = soundSourceFrequency; // undefined for absolute-frequency modulator
        this.#implementation.frequencyModulatorList = [];
        this.#implementation.amplitudeModulatorList = [];
        this.#implementation.populate = (modulatorList, modulationData) => {
            for (let modulator of modulatorList)
                modulator.deactivate(); // full replacement: stop and disconnect every old modulator, nothing may stack up
            modulatorList.splice(0);
            for (let dataElement of modulationData.modes) {
                let frequency = dataElement.frequency;
                if (soundSourceFrequency)
                    frequency *= soundSourceFrequency;
                const modulator = new Modulator(this.context);
                modulator.depth = dataElement.depth;
                modulator.frequency = frequency;
                modulatorList.push(modulator);
            } //loop
        }; //this.#implementation.populate
        this.#implementation.connectModulators = (modulatorList, masterDepthNode) => {
            if (!masterDepthNode) return;
            for (let modulator of modulatorList)
                modulator.connect(masterDepthNode);
        }; //this.#implementation.connectModulators
        this.#implementation.applyMasterDepth = (masterDepthNode, depth, isEnabled) => {
            if (masterDepthNode)
                masterDepthNode.gain.value = isEnabled ? depth : 0;
        }; //this.#implementation.applyMasterDepth
        this.#implementation.baseDeactivate = _ => {
            for (let modulator of this.#implementation.frequencyModulatorList)
                modulator.deactivate();
            for (let modulator of this.#implementation.amplitudeModulatorList)
                modulator.deactivate();
        }; //baseDeactivate
    } //constructor

    // interface:

    set frequencyModulationData(dataset) {
        this.#implementation.fmMasterDepth = dataset.masterDepth;
        this.#implementation.populate(this.#implementation.frequencyModulatorList, dataset);
        // re-attach the freshly created modulators to the existing master-depth node, if any:
        this.#implementation.connectModulators(
            this.#implementation.frequencyModulatorList,
            this.#implementation.frequencyModulatatioMasterDepth);
        this.#implementation.applyMasterDepth(
            this.#implementation.frequencyModulatatioMasterDepth,
            this.#implementation.fmMasterDepth,
            this.#implementation.isFmEnabled);
    } //set frequencyModulationData
    set amplitudeModulationData(dataset) {
        this.#implementation.amMasterDepth = dataset.masterDepth;
        this.#implementation.populate(this.#implementation.amplitudeModulatorList, dataset);
        this.#implementation.connectModulators(
            this.#implementation.amplitudeModulatorList,
            this.#implementation.amplitudeModulatatioMasterDepth);
        this.#implementation.applyMasterDepth(
            this.#implementation.amplitudeModulatatioMasterDepth,
            this.#implementation.amMasterDepth,
            this.#implementation.isAmEnabled);
    } //set amplitudeModulationData

    connectToAudioParameters(frequencyAudioParameter, amplitudeAudioParameter) {
        this.#implementation.frequencyAudioParameter = frequencyAudioParameter;
        this.#implementation.amplitudeAudioParameter = amplitudeAudioParameter;
        const connectTo = (list, masterDepthNode, audioParameter, depth, isEnabled) => {
            for (let modulator of list)
                modulator.connect(masterDepthNode);
            masterDepthNode.connect(audioParameter);
            this.#implementation.applyMasterDepth(masterDepthNode, depth, isEnabled);
        } //connectTo
        if (frequencyAudioParameter) {
            if (!this.#implementation.frequencyModulatatioMasterDepth)
                this.#implementation.frequencyModulatatioMasterDepth = new GainNode(this.context, { gain: 1 });
            connectTo(
                this.#implementation.frequencyModulatorList,
                this.#implementation.frequencyModulatatioMasterDepth,
                frequencyAudioParameter,
                this.#implementation.fmMasterDepth,
                this.#implementation.isFmEnabled);
        } //if
        if (amplitudeAudioParameter) {
            if (!this.#implementation.amplitudeModulatatioMasterDepth)
                this.#implementation.amplitudeModulatatioMasterDepth = new GainNode(this.context, { gain: 1 });
            connectTo(
                this.#implementation.amplitudeModulatorList,
                this.#implementation.amplitudeModulatatioMasterDepth,
                amplitudeAudioParameter,
                this.#implementation.amMasterDepth,
                this.#implementation.isAmEnabled);
        } //if
    } //connectToAudioParameters

    set frequencyModulationEnable(enable) {
        this.#implementation.isFmEnabled = enable;
        this.#implementation.applyMasterDepth(
            this.#implementation.frequencyModulatatioMasterDepth,
            this.#implementation.fmMasterDepth,
            enable);
    } //set frequencyModulationEnable
    get frequencyModulationEnable() { return this.#implementation.isFmEnabled; }

    set amplitudeModulationEnable(enable) {
        this.#implementation.isAmEnabled = enable;
        this.#implementation.applyMasterDepth(
            this.#implementation.amplitudeModulatatioMasterDepth,
            this.#implementation.amMasterDepth,
            enable);
    } //set amplitudeModulationEnable
    get amplitudeModulationEnable() { return this.#implementation.isAmEnabled; }

    baseDeactivate() { this.#implementation.baseDeactivate(); }

} //class ModulatorSet
