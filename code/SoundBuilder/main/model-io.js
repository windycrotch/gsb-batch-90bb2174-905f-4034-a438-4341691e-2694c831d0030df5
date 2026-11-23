// Microtonal Fabric
//
// Copyright (c) Sergey A Kryukov, 2017-2021
//
// http://www.SAKryukov.org
// http://www.codeproject.com/Members/SAKryukov
// https://github.com/SAKryukov
// https://github.com/SAKryukov/microtonal-fabric

"use strict";

// Loading and application of instrument models as fault-tolerant operations:
// a failed load changes nothing, a deferred load cannot be lost
// because of an interleaved apply.
const instrumentModelIO = {

    // Parses instrument file text and validates its header.
    // Throws on any problem; on success returns the parsed model.
    // The caller's current model is never touched on failure.
    parseInstrumentFile: (text, currentFormatVersion) => {
        const model = JSON.parse(text); // throws SyntaxError on malformed JSON
        if (!model.header)
            throw new Error(`header should be specified`);
        const loadedFormatVersion = parseFloat(model.header.formatVersion);
        if (Number.isNaN(loadedFormatVersion))
            throw new Error(`invalid format version: "${model.header.formatVersion}"`);
        const currentVersion = parseFloat(currentFormatVersion);
        if ((currentVersion >= loadedFormatVersion) != true) //sic!
            throw new Error(
                `File format version should be lower or equal to ${currentFormatVersion}, ` +
                `otherwise newer version of the application might be required`);
        return model;
    }, //parseInstrumentFile

    // Applies a previously loaded model to the view and the instrument, as one step.
    // The model is assigned to the singleton at application time (not at load time),
    // so an apply() that happened between loading the file and this deferred call
    // cannot overwrite and lose the loaded data.
    applyLoadedModel: (singleton, loadedModel, apply) => {
        singleton.model = loadedModel;
        singleton.modelToView();
        apply();
    }, //applyLoadedModel

}; //instrumentModelIO
