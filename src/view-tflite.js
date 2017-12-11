/*jshint esversion: 6 */

// Experimental

class TensorFlowLiteModel {
    
    constructor(hostService) {
        this._hostService = hostService;
    }

    openBuffer(buffer, identifier) { 
        try {
            var byteBuffer = new flatbuffers.ByteBuffer(buffer);
            if (!tflite.Model.bufferHasIdentifier(byteBuffer))
            {
                throw 'Invalid identifier';
            }
            this._model = tflite.Model.getRootAsModel(byteBuffer);
            this._graphs = [];
            for (var subgraph = 0; subgraph < this._model.subgraphsLength(); subgraph++) {
                this._graphs.push(new TensorFlowLiteGraph(this, this._model.subgraphs(subgraph), subgraph));
            }
            this._activeGraph = this._graphs.length > 0 ? this._graphs[0] : null;
            this._operatorMetadata = new TensorFlowLiteOperatorMetadata(this._hostService);
            this._operatorCodeList = [];
            var builtinOperatorMap = {};
            Object.keys(tflite.BuiltinOperator).forEach(function (key) {
                var upperCase = { '2D': true, 'LSH': true, 'SVDF': true, 'RNN': true, 'L2': true, 'LSTM': true };
                var builtinOperatorIndex = tflite.BuiltinOperator[key]; 
                builtinOperatorMap[builtinOperatorIndex] = key.split('_').map((s) => {
                    return (s.length < 1 || upperCase[s]) ? s : s.substring(0, 1) + s.substring(1).toLowerCase();
                }).join('');
            });
            for (var operatorIndex = 0; operatorIndex < this._model.operatorCodesLength(); operatorIndex++) {
                var operatorCode = this._model.operatorCodes(operatorIndex);
                var builtinCode = operatorCode.builtinCode();
                this._operatorCodeList.push((builtinCode == tflite.BuiltinOperator.CUSTOM) ? operatorCode.customCode() : builtinOperatorMap[builtinCode]);
            }
        }
        catch (err) {
            return err;
        }
        return null;
    }

    format() {
        var summary = { properties: [], graphs: [] };

        this.graphs.forEach((graph) => {
            summary.graphs.push({
                name: graph.name,
                inputs: graph.inputs,
                outputs: graph.outputs
            });
        });

        var format = 'TensorFlow Lite v' + this._model.version().toString();
        summary.properties.push({ name: 'Format', value: format });

        var description = this._model.description();
        if (description && description.length > 0) {
            summary.properties.push({ name: 'Description', value: description });
        }

        return summary;
    }

    get graphs() {
        return this._graphs;
    }

    get activeGraph() {
        return this._activeGraph;
    }

    updateActiveGraph(name) {
        this.graphs.forEach((graph) => {
            if (name == graph.name) {
                this._activeGraph = graph;
                return;
            }            
        });
    }
} 

class TensorFlowLiteGraph {

    constructor(model, graph, index) {
        this._model = model;
        this._graph = graph;
        this._name = this._graph.name() ? this._graph.name() : ('(' + index.toString() + ')');            
    }

    get model() {
        return this._model;
    }

    get name() {
        return this._name;
    }

    get inputs() {
        if (!this._inputs) {
            this._inputs = [];
            var graph = this._graph;
            for (var i = 0; i < graph.inputsLength(); i++) {
                var tensorIndex = graph.inputs(i);
                var tensor = graph.tensors(tensorIndex);
                this._inputs.push({ 
                    id: tensorIndex.toString(),
                    name: tensor.name(),
                    type: this.formatTensorType(tensor) 
                });
            }
        }
        return this._inputs;
    }

    get outputs() {
        if (!this._outputs) {
            this._outputs = [];
            var graph = this._graph;
            for (var i = 0; i < graph.outputsLength(); i++) {
                var tensorIndex = graph.outputs(i);
                var tensor = graph.tensors(tensorIndex);
                this._outputs.push({ 
                    id: tensorIndex.toString(),
                    name: tensor.name(),
                    type: this.formatTensorType(tensor) 
                });
            }
        }
        return this._outputs;
    }

    get initializers() {
        if (!this._initializers)
        {
            this._initializers = [];
            var graph = this._graph;
            var model = this._model._model;
            for (var i = 0; i < graph.tensorsLength(); i++) {
                var tensor = graph.tensors(i);
                var buffer = model.buffers(tensor.buffer());
                if (buffer.dataLength() > 0) {
                    tensor = this.formatTensor(tensor, buffer);
                    tensor.id = i.toString();
                    this._initializers.push(tensor);
                }
            }    
        }
        return this._initializers;
    }

    get nodes() {
        /* for (var i = 0; i < graph.operatorsLength(); i++) {
            var node = graph.operators(i);
            var inputs = [];
            for (var j = 0; j < node.inputsLength(); j++) {
                inputs.push(node.inputs(j));
            }
            var outputs = [];
            for (var j = 0; j < node.outputsLength(); j++) {
                outputs.push(node.outputs(j));
            }
            console.log(this.getNodeOperator(node) + ' [' + inputs.join(',') + '] -> [' + outputs.join(',') + ']');
        } */
        var results = [];
        for (var i = 0; i < this._graph.operatorsLength(); i++) {
            var node = this._graph.operators(i);
            results.push(new TensorFlowLiteNode(this, node));
        } 
        return results;
    }

    formatTensorType(tensor) {
        if (!this.tensorTypeMap)
        {
            this.tensorTypeMap = {};
            this.tensorTypeMap[tflite.TensorType.FLOAT32] = 'float';
            this.tensorTypeMap[tflite.TensorType.FLOAT16] = 'float16';
            this.tensorTypeMap[tflite.TensorType.INT32] = 'int32';
            this.tensorTypeMap[tflite.TensorType.UINT8] = 'byte';
            this.tensorTypeMap[tflite.TensorType.INT64] = 'int64';
            this.tensorTypeMap[tflite.TensorType.STRING] = 'string';
        }
        var result = this.tensorTypeMap[tensor.type()]; 
        if (!result) {
            debugger;
            result = '?';
        }
        var shapeLength = tensor.shapeLength();
        if (shapeLength > 0) {
            var dimensions = [];
            for (var i = 0; i < shapeLength; i++) {
                dimensions.push(tensor.shape(i).toString());
            }
            result += '[' + dimensions.join(',') + ']';
        }
        return result;
    }

    formatTensor(tensor, buffer) {
        var result = {};
        result.name = tensor.name();
        result.type = this.formatTensorType(tensor);
        result.value = function () { return new TensorFlowLiteTensorFormatter(tensor, buffer).toString(); };
        return result;
    }
}

class TensorFlowLiteNode {

    constructor(graph, node) {
        this._graph = graph;
        this._node = node;
    }

    get operator() {
        if (!this._operator) {
            var operatorCodeList = this._graph.model._operatorCodeList;
            var opcodeIndex = this._node.opcodeIndex();
            this._operator = (opcodeIndex < operatorCodeList.length) ?
                operatorCodeList[opcodeIndex] :
                ('(' + opcodeIndex.toString() + ')');
        }
        return this._operator;
    }

    get inputs() {
        if (!this._inputs) {
            this._inputs = [];
            var operatorMetadata = this._graph.model._operatorMetadata;
            var graph = this._graph._graph;
            var node = this._node;
            for (var i = 0; i < node.inputsLength(); i++) {
                var tensorIndex = node.inputs(i);
                var tensor = graph.tensors(tensorIndex);
                this._inputs.push({
                    id: tensorIndex.toString(),
                    name: operatorMetadata.getInputName(this.operator, i),
                    type: this._graph.formatTensorType(tensor)
                });
            }
        }
        return this._inputs;
    }

    get outputs() {
        if (!this._outputs) {
            this._outputs = [];
            var operatorMetadata = this._graph.model._operatorMetadata;
            var graph = this._graph._graph;
            var node = this._node;
            var result = [];
            for (var i = 0; i < node.outputsLength(); i++) {
                var tensorIndex = node.outputs(i);
                var tensor = graph.tensors(tensorIndex);
                this._outputs.push({
                    id: tensorIndex.toString(),
                    name: operatorMetadata.getOutputName(this.operator, i),
                    type: this._graph.formatTensorType(tensor)
                });
            }
        }
        return this._outputs;
    }

    get properties() {
        return [];
    }

    get attributes() {
        if (!this._attributes) {
            this._attributes = [];
            var node = this._node;
            var operatorName = this._operator;
            var optionsTypeName = 'tflite.' + operatorName + 'Options';
            var optionsType = eval(optionsTypeName);
            if (typeof optionsType === 'function') {
                var options = eval('new ' + optionsTypeName + '()');
                node.builtinOptions(options);
                var attributeNames = [];
                Object.keys(Object.getPrototypeOf(options)).forEach(function (attributeName) {
                    if (attributeName != '__init') {
                        attributeNames.push(attributeName);
                    }
                });
                attributeNames.forEach((attributeName) => {
                    if (options[attributeName] && typeof options[attributeName] == 'function') {
                        var value = options[attributeName]();
                        value = this.formatAttributeValue(value, attributeName, optionsTypeName);
                        if (value != null) {
                            this._attributes.push({
                                name: this.formatAttributeName(attributeName),
                                type: '',
                                value: () => { return value; }, 
                                value_short: () => { return value; }
                            });
                        }
                    }
                });
            }
        }
        return this._attributes;
    }

    get documentation() {
        return null;
    }

    formatAttributeName(name) {
        var lower = name.toLowerCase();
        var result = '';
        for (var i = 0; i < name.length; i++) {
            result += (name[i] == lower[i]) ? name[i] : ('_' + lower[i]);
        }
        return result;
    }

    formatAttributeValue(attributeValue, attributeName, optionsTypeName) {
        if (!this._graph._model._optionsEnumTypeMap) {
            this._graph._model._optionsEnumTypeMap = {};
            var optionsEnumTypeMap = this._graph._model._optionsEnumTypeMap;
            optionsEnumTypeMap['tflite.Conv2DOptions'] = {
                padding: { type: tflite.Padding },
                fusedActivationFunction: { type: tflite.ActivationFunctionType, default: 'NONE' }
            };
            optionsEnumTypeMap['tflite.Pool2DOptions'] = {
                padding: { type: tflite.Padding },
                fusedActivationFunction: { type: tflite.ActivationFunctionType, default: 'NONE' }
            };
            optionsEnumTypeMap['tflite.DepthwiseConv2DOptions'] = {
                padding: { type: tflite.Padding },
                fusedActivationFunction: { type: tflite.ActivationFunctionType, default: 'NONE' }
            };
            optionsEnumTypeMap['tflite.LSHProjectionOptions'] = {
                type: { type: tflite.LSHProjectionType }
            };
            optionsEnumTypeMap['tflite.SVDFOptions'] = {
                fusedActivationFunction: { type: tflite.ActivationFunctionType, default: 'NONE' }
            };
            optionsEnumTypeMap['tflite.RNNOptions'] = {
                fusedActivationFunction: { type: tflite.ActivationFunctionType, default: 'NONE' }
            };
            optionsEnumTypeMap['tflite.FullyConnectedOptions'] = {
                fusedActivationFunction: { type: tflite.ActivationFunctionType, default: 'NONE' }
            };
            optionsEnumTypeMap['tflite.ConcatenationOptions'] = {
                fusedActivationFunction: { type: tflite.ActivationFunctionType, default: 'NONE' }
            };
            optionsEnumTypeMap['tflite.AddOptions'] = {
                fusedActivationFunction: { type: tflite.ActivationFunctionType, default: 'NONE' }
            };
            optionsEnumTypeMap['tflite.MulOptions'] = {
                fusedActivationFunction: { type: tflite.ActivationFunctionType, default: 'NONE' }
            };
            optionsEnumTypeMap['tflite.L2NormOptions'] = {
                fusedActivationFunction: { type: tflite.ActivationFunctionType, default: 'NONE' }
            };
            optionsEnumTypeMap['tflite.LSTMOptions'] = {
                fusedActivationFunction: { type: tflite.ActivationFunctionType, default: 'NONE' }
            };
            optionsEnumTypeMap['tflite.EmbeddingLookupSparseOptions'] = {
                combiner: { type: tflite.CombinerType }
            };
        }
        var optionsEnumType = this._graph._model._optionsEnumTypeMap[optionsTypeName];
        if (optionsEnumType) {
            var attributeType = optionsEnumType[attributeName];
            if (attributeType) {
                var map = attributeType.map;
                if (!map) {
                    map = {};
                    var enumType = attributeType.type;
                    Object.keys(enumType).forEach(function (key) {
                        map[enumType[key]] = key;
                    });
                    attributeType.map = map;
                }
                var enumValue = map[attributeValue];
                if (enumValue) {
                    var defaultValue = attributeType.default;
                    if (defaultValue && defaultValue == enumValue) {
                        return null;
                    }
                    return enumValue;
                }
            }
        }
        return attributeValue;
    }
}

class TensorFlowLiteTensorFormatter {

    constructor(tensor, buffer) {
        this.tensor = tensor;
        this.buffer = buffer;
        if (window.TextDecoder) {
            this.utf8Decoder = new TextDecoder('utf-8');
        }
    }

    toString() {
        var size = 1;
        for (var i = 0; i < this.tensor.shapeLength(); i++) {
            size *= this.tensor.shape(i);
        }
        if (size > 65536) {
            return 'Tensor is too large to display.';
        }

        if (this.buffer.dataLength() == 0) {
            return 'Tensor data is empty.';
        }

        var array = this.buffer.dataArray();
        this.data = new DataView(array.buffer, array.byteOffset, array.byteLength);

        if (this.tensor.type() == tflite.TensorType.STRING) {
            var offset = 0;
            var count = this.data.getInt32(0, true);
            offset += 4;
            var offsetTable = [];
            for (var j = 0; j < count; j++) {
                offsetTable.push(this.data.getInt32(offset, true));
                offset += 4;
            }
            offsetTable.push(array.length);
            var stringTable = [];
            for (var k = 0; k < count; k++) {
                var textArray = array.subarray(offsetTable[k], offsetTable[k + 1]);
                if (this.utf8Decoder) {
                    stringTable.push(this.utf8Decoder.decode(textArray));
                }
                else {
                    stringTable.push(String.fromCharCode.apply(null, textArray));
                }
            }
            this.data = stringTable;
        }

        this.index = 0;                
        var result = this.read(0);
        this.data = null;

        return JSON.stringify(result, null, 4);
    }

    read(dimension) {
        var size = this.tensor.shape(dimension);
        var results = [];
        if (dimension == this.tensor.shapeLength() - 1) {
            for (var i = 0; i < size; i++) {
                switch (this.tensor.type())
                {
                    case tflite.TensorType.FLOAT32:
                        results.push(this.data.getFloat32(this.index, true));
                        this.index += 4;
                        break;
                    case tflite.TensorType.FLOAT16:
                        results.push(this.decodeNumberFromFloat16(this.data.getUint16(this.index, true)));
                        this.index += 2;
                        break;
                    case tflite.TensorType.UINT8:
                        results.push(this.data.getUint8(this.index));
                        this.index += 4;
                        break;
                    case tflite.TensorType.INT32:
                        results.push(this.data.getInt32(this.index, true));
                        this.index += 4;
                        break;
                    case tflite.TensorType.INT64:
                        results.push(new Int64(this.data.getInt64(this.index, true)));
                        this.index += 8;
                        break;
                    case tflite.TensorType.STRING:
                        results.push(this.data[this.index++]);
                        break;
                    default:
                        debugger;
                        break;
                }
            }
        }
        else {
            for (var j = 0; j < size; j++) {
                results.push(this.read(dimension + 1));
            }
        }
        return results;
    }

    decodeNumberFromFloat16(value) {
        var s = (value & 0x8000) >> 15;
        var e = (value & 0x7C00) >> 10;
        var f = value & 0x03FF;
        if(e == 0) {
            return (s ? -1 : 1) * Math.pow(2, -14) * (f / Math.pow(2, 10));
        }
        else if (e == 0x1F) {
            return f ? NaN : ((s ? -1 : 1) * Infinity);
        }
        return (s ? -1 : 1) * Math.pow(2, e-15) * (1 + (f / Math.pow(2, 10)));
    }
}

class TensorFlowLiteOperatorMetadata {
    constructor() {
        this.map = {};
        hostService.request('/tflite-operator.json', (err, data) => {
            if (err != null) {
                // TODO error
            }
            else {
                var items = JSON.parse(data);
                if (items) {
                    items.forEach((item) => {
                        if (item.name && item.schema)
                        {
                            var name = item.name;
                            var schema = item.schema;
                            this.map[name] = schema;
                        }
                    });
                }
            }
        });
    }

    getInputName(operator, index) {
        var schema = this.map[operator];
        if (schema) {
            var inputs = schema.inputs;
            if (inputs && index < inputs.length) {
                var input = inputs[index];
                if (input) {
                    if (!input.option || input.option != 'variadic') {
                        var name = input.name;
                        if (name) {
                            return name;
                        }
                    }
                } 
            }
        }
        return "(" + index.toString() + ")";
    }

    getOutputName(operator, index) {
        var schema = this.map[operator];
        if (schema) {
            var outputs = schema.outputs;
            if (outputs && index < outputs.length) {
                var output = outputs[index];
                if (output) {
                    if (!output.option || output.option != 'variadic') {
                        var name = output.name;
                        if (name) {
                            return name;
                        }
                    }
                } 
            }
        }
        return "(" + index.toString() + ")";
    }
}