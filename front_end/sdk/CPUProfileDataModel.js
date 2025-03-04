// Copyright 2014 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Common from '../common/common.js';

import {ProfileNode, ProfileTreeModel} from './ProfileTreeModel.js';
import {Target} from './SDKModel.js';  // eslint-disable-line no-unused-vars

export class CPUProfileNode extends ProfileNode {
  /**
   * @param {!Protocol.Profiler.ProfileNode} node
   * @param {number} sampleTime
   */
  constructor(node, sampleTime) {
    const callFrame = node.callFrame || /** @type {!Protocol.Runtime.CallFrame} */ ({
                        // Backward compatibility for old SamplingHeapProfileNode format.
                        // @ts-ignore Legacy types
                        functionName: node['functionName'],
                        // @ts-ignore Legacy types
                        scriptId: node['scriptId'],
                        // @ts-ignore Legacy types
                        url: node['url'],
                        // @ts-ignore Legacy types
                        lineNumber: node['lineNumber'] - 1,
                        // @ts-ignore Legacy types
                        columnNumber: node['columnNumber'] - 1
                      });
    super(callFrame);
    this.id = node.id;
    this.self = (node.hitCount || 0) * sampleTime;
    this.positionTicks = node.positionTicks;
    // Compatibility: legacy backends could provide "no reason" for optimized functions.
    this.deoptReason = node.deoptReason && node.deoptReason !== 'no reason' ? node.deoptReason : null;
  }
}

export class CPUProfileDataModel extends ProfileTreeModel {
  /**
   * @param {!Protocol.Profiler.Profile} profile
   * @param {?Target} target
   */
  constructor(profile, target) {
    super(target);
    // @ts-ignore Legacy types
    const isLegacyFormat = Boolean(profile['head']);
    if (isLegacyFormat) {
      // Legacy format contains raw timestamps and start/stop times are in seconds.
      this.profileStartTime = profile.startTime * 1000;
      this.profileEndTime = profile.endTime * 1000;
      // @ts-ignore Legacy types
      this.timestamps = profile.timestamps;
      this._compatibilityConversionHeadToNodes(profile);
    } else {
      // Current format encodes timestamps as deltas. Start/stop times are in microseconds.
      this.profileStartTime = profile.startTime / 1000;
      this.profileEndTime = profile.endTime / 1000;
      this.timestamps = this._convertTimeDeltas(profile);
    }
    this.samples = profile.samples;
    // @ts-ignore Legacy types
    this.lines = profile.lines;
    this.totalHitCount = 0;
    this.profileHead = this._translateProfileTree(profile.nodes);
    this.initialize(this.profileHead);
    this._extractMetaNodes();
    if (this.samples) {
      this._buildIdToNodeMap();
      this._sortSamples();
      this._normalizeTimestamps();
      this._fixMissingSamples();
    }
    /** @type {!Array<number>} */
    this.timestamps;
    /** @type {!Map<number, !CPUProfileNode>} */
    this._idToNode;
    /** @type {!CPUProfileNode} */
    this.gcNode;
  }

  /**
   * @param {!Protocol.Profiler.Profile} profile
   */
  _compatibilityConversionHeadToNodes(profile) {
    // @ts-ignore Legacy types
    if (!profile.head || profile.nodes) {
      return;
    }
    /** @type {!Array<!Protocol.Profiler.ProfileNode>} */
    const nodes = [];
    // @ts-ignore Legacy types
    convertNodesTree(profile.head);
    profile.nodes = nodes;
    // @ts-ignore Legacy types
    delete profile.head;
    /**
     * @param {!Protocol.Profiler.ProfileNode} node
     * @return {number}
     */
    function convertNodesTree(node) {
      nodes.push(node);
      // @ts-ignore Legacy types
      node.children = (/** @type {!Array<!Protocol.Profiler.ProfileNode>} */ (node.children)).map(convertNodesTree);
      return node.id;
    }
  }

  /**
   * @param {!Protocol.Profiler.Profile} profile
   * @return {!Array<number>}
   */
  _convertTimeDeltas(profile) {
    if (!profile.timeDeltas) {
      return [];
    }
    let lastTimeUsec = profile.startTime;
    const timestamps = new Array(profile.timeDeltas.length);
    for (let i = 0; i < profile.timeDeltas.length; ++i) {
      lastTimeUsec += profile.timeDeltas[i];
      timestamps[i] = lastTimeUsec;
    }
    return timestamps;
  }

  /**
   * @param {!Array<!Protocol.Profiler.ProfileNode>} nodes
   * @return {!CPUProfileNode}
   */
  _translateProfileTree(nodes) {
    /**
     * @param {!Protocol.Profiler.ProfileNode} node
     * @return {boolean}
     */
    function isNativeNode(node) {
      if (node.callFrame) {
        return Boolean(node.callFrame.url) && node.callFrame.url.startsWith('native ');
      }
      // @ts-ignore Legacy types
      return Boolean(node['url']) && node['url'].startsWith('native ');
    }

    /**
     * @param {!Array<!Protocol.Profiler.ProfileNode>} nodes
     */
    function buildChildrenFromParents(nodes) {
      if (nodes[0].children) {
        return;
      }
      nodes[0].children = [];
      for (let i = 1; i < nodes.length; ++i) {
        const node = nodes[i];
        // @ts-ignore Legacy types
        const parentNode = nodeByIdMap.get(node.parent);
        // @ts-ignore Legacy types
        if (parentNode.children) {
          // @ts-ignore Legacy types
          parentNode.children.push(node.id);
        } else {
          // @ts-ignore Legacy types
          parentNode.children = [node.id];
        }
      }
    }

    /**
     * @param {!Array<!Protocol.Profiler.ProfileNode>} nodes
     * @param {!Array<number>|undefined} samples
     */
    function buildHitCountFromSamples(nodes, samples) {
      if (typeof (nodes[0].hitCount) === 'number') {
        return;
      }
      if (!samples) {
        throw new Error('Error: Neither hitCount nor samples are present in profile.');
      }
      for (let i = 0; i < nodes.length; ++i) {
        nodes[i].hitCount = 0;
      }
      for (let i = 0; i < samples.length; ++i) {
        ++/** @type {number} */ (/** @type {!Protocol.Profiler.ProfileNode} */ (nodeByIdMap.get(samples[i])).hitCount);
      }
    }

    /** @type {!Map<number, !Protocol.Profiler.ProfileNode>} */
    const nodeByIdMap = new Map();
    for (let i = 0; i < nodes.length; ++i) {
      const node = nodes[i];
      nodeByIdMap.set(node.id, node);
    }

    buildHitCountFromSamples(nodes, this.samples);
    buildChildrenFromParents(nodes);
    this.totalHitCount = nodes.reduce((acc, node) => acc + (node.hitCount || 0), 0);
    const sampleTime = (this.profileEndTime - this.profileStartTime) / this.totalHitCount;
    const keepNatives =
        Boolean(Common.Settings.Settings.instance().moduleSetting('showNativeFunctionsInJSProfile').get());
    const root = nodes[0];
    /** @type {!Map<number, number>} */
    const idMap = new Map([[root.id, root.id]]);
    const resultRoot = new CPUProfileNode(root, sampleTime);
    if (!root.children) {
      throw new Error('Missing children for root');
    }
    const parentNodeStack = root.children.map(() => resultRoot);
    const sourceNodeStack = root.children.map(id => nodeByIdMap.get(id));
    while (sourceNodeStack.length) {
      let parentNode = parentNodeStack.pop();
      const sourceNode = sourceNodeStack.pop();
      if (!sourceNode || !parentNode) {
        continue;
      }
      if (!sourceNode.children) {
        sourceNode.children = [];
      }
      const targetNode = new CPUProfileNode(sourceNode, sampleTime);
      if (keepNatives || !isNativeNode(sourceNode)) {
        parentNode.children.push(targetNode);
        parentNode = targetNode;
      } else {
        parentNode.self += targetNode.self;
      }
      idMap.set(sourceNode.id, parentNode.id);
      parentNodeStack.push.apply(
          parentNodeStack, sourceNode.children.map(() => /** @type {!CPUProfileNode} */ (parentNode)));
      sourceNodeStack.push.apply(sourceNodeStack, sourceNode.children.map(id => nodeByIdMap.get(id)));
    }
    if (this.samples) {
      this.samples = this.samples.map(id => /** @type {number} */ (idMap.get(id)));
    }
    return resultRoot;
  }

  _sortSamples() {
    const timestamps = this.timestamps;
    if (!timestamps) {
      return;
    }
    const samples = this.samples;
    if (!samples) {
      return;
    }
    const indices = timestamps.map((x, index) => index);
    indices.sort((a, b) => timestamps[a] - timestamps[b]);
    for (let i = 0; i < timestamps.length; ++i) {
      let index = indices[i];
      if (index === i) {
        continue;
      }
      // Move items in a cycle.
      const savedTimestamp = timestamps[i];
      const savedSample = samples[i];
      let currentIndex = i;
      while (index !== i) {
        samples[currentIndex] = samples[index];
        timestamps[currentIndex] = timestamps[index];
        currentIndex = index;
        index = indices[index];
        indices[currentIndex] = currentIndex;
      }
      samples[currentIndex] = savedSample;
      timestamps[currentIndex] = savedTimestamp;
    }
  }

  _normalizeTimestamps() {
    if (!this.samples) {
      return;
    }
    let timestamps = this.timestamps;
    if (!timestamps) {
      // Support loading old CPU profiles that are missing timestamps.
      // Derive timestamps from profile start and stop times.
      const profileStartTime = this.profileStartTime;
      const interval = (this.profileEndTime - profileStartTime) / this.samples.length;
      timestamps = /** @type {!Array<number>} */ (/** @type {*} */ (new Float64Array(this.samples.length + 1)));
      for (let i = 0; i < timestamps.length; ++i) {
        timestamps[i] = profileStartTime + i * interval;
      }
      this.timestamps = timestamps;
      return;
    }

    // Convert samples from usec to msec
    for (let i = 0; i < timestamps.length; ++i) {
      timestamps[i] /= 1000;
    }
    if (this.samples.length === timestamps.length) {
      // Support for a legacy format where were no timeDeltas.
      // Add an extra timestamp used to calculate the last sample duration.
      const averageSample = ((timestamps.peekLast() || 0) - timestamps[0]) / (timestamps.length - 1);
      this.timestamps.push((timestamps.peekLast() || 0) + averageSample);
    }
    this.profileStartTime = timestamps[0];
    this.profileEndTime = /** @type {number} */ (timestamps.peekLast());
  }

  _buildIdToNodeMap() {
    this._idToNode = new Map();
    const idToNode = this._idToNode;
    const stack = [this.profileHead];
    while (stack.length) {
      const node = /** @type {!CPUProfileNode} */ (stack.pop());
      idToNode.set(node.id, node);
      // @ts-ignore Legacy types
      stack.push.apply(stack, node.children);
    }
  }

  _extractMetaNodes() {
    const topLevelNodes = this.profileHead.children;
    for (let i = 0; i < topLevelNodes.length && !(this.gcNode && this.programNode && this.idleNode); i++) {
      const node = topLevelNodes[i];
      if (node.functionName === '(garbage collector)') {
        this.gcNode = /** @type {!CPUProfileNode} */ (node);
      } else if (node.functionName === '(program)') {
        this.programNode = node;
      } else if (node.functionName === '(idle)') {
        this.idleNode = node;
      }
    }
  }

  _fixMissingSamples() {
    // Sometimes sampler is not able to parse the JS stack and returns
    // a (program) sample instead. The issue leads to call frames belong
    // to the same function invocation being split apart.
    // Here's a workaround for that. When there's a single (program) sample
    // between two call stacks sharing the same bottom node, it is replaced
    // with the preceeding sample.
    const samples = this.samples;
    if (!samples) {
      return;
    }
    const samplesCount = samples.length;
    if (!this.programNode || samplesCount < 3) {
      return;
    }
    const idToNode = this._idToNode;
    const programNodeId = this.programNode.id;
    const gcNodeId = this.gcNode ? this.gcNode.id : -1;
    const idleNodeId = this.idleNode ? this.idleNode.id : -1;
    let prevNodeId = samples[0];
    let nodeId = samples[1];
    let count = 0;
    for (let sampleIndex = 1; sampleIndex < samplesCount - 1; sampleIndex++) {
      const nextNodeId = samples[sampleIndex + 1];
      if (nodeId === programNodeId && !isSystemNode(prevNodeId) && !isSystemNode(nextNodeId) &&
          bottomNode(/** @type {!ProfileNode} */ (idToNode.get(prevNodeId))) ===
              bottomNode(/** @type {!ProfileNode} */ (idToNode.get(nextNodeId)))) {
        ++count;
        samples[sampleIndex] = prevNodeId;
      }
      prevNodeId = nodeId;
      nodeId = nextNodeId;
    }
    if (count) {
      Common.Console.Console.instance().warn(ls`DevTools: CPU profile parser is fixing ${count} missing samples.`);
    }
    /**
     * @param {!ProfileNode} node
     * @return {!ProfileNode}
     */
    function bottomNode(node) {
      while (node.parent && node.parent.parent) {
        node = node.parent;
      }
      return node;
    }
    /**
     * @param {number} nodeId
     * @return {boolean}
     */
    function isSystemNode(nodeId) {
      return nodeId === programNodeId || nodeId === gcNodeId || nodeId === idleNodeId;
    }
  }

  /**
   * @param {function(number, !CPUProfileNode, number):void} openFrameCallback
   * @param {function(number, !CPUProfileNode, number, number, number):void} closeFrameCallback
   * @param {number=} startTime
   * @param {number=} stopTime
   */
  forEachFrame(openFrameCallback, closeFrameCallback, startTime, stopTime) {
    if (!this.profileHead || !this.samples) {
      return;
    }

    startTime = startTime || 0;
    stopTime = stopTime || Infinity;
    const samples = this.samples;
    const timestamps = this.timestamps;
    const idToNode = this._idToNode;
    const gcNode = this.gcNode;
    const samplesCount = samples.length;
    const startIndex = timestamps.lowerBound(startTime);
    let stackTop = 0;
    const stackNodes = [];
    let prevId = this.profileHead.id;
    let sampleTime;
    /** @type {?CPUProfileNode} */
    let gcParentNode = null;

    // Extra slots for gc being put on top,
    // and one at the bottom to allow safe stackTop-1 access.
    const stackDepth = this.maxDepth + 3;
    if (!this._stackStartTimes) {
      this._stackStartTimes = new Float64Array(stackDepth);
    }
    const stackStartTimes = this._stackStartTimes;
    if (!this._stackChildrenDuration) {
      this._stackChildrenDuration = new Float64Array(stackDepth);
    }
    const stackChildrenDuration = this._stackChildrenDuration;

    let node;
    let sampleIndex;
    for (sampleIndex = startIndex; sampleIndex < samplesCount; sampleIndex++) {
      sampleTime = timestamps[sampleIndex];
      if (sampleTime >= stopTime) {
        break;
      }
      const id = samples[sampleIndex];
      if (id === prevId) {
        continue;
      }
      node = idToNode.get(id);
      let prevNode = /** @type {!CPUProfileNode} */ (idToNode.get(prevId));

      if (node === gcNode) {
        // GC samples have no stack, so we just put GC node on top of the last recorded sample.
        gcParentNode = prevNode;
        openFrameCallback(gcParentNode.depth + 1, gcNode, sampleTime);
        stackStartTimes[++stackTop] = sampleTime;
        stackChildrenDuration[stackTop] = 0;
        prevId = id;
        continue;
      }
      if (prevNode === gcNode && gcParentNode) {
        // end of GC frame
        const start = stackStartTimes[stackTop];
        const duration = sampleTime - start;
        stackChildrenDuration[stackTop - 1] += duration;
        closeFrameCallback(gcParentNode.depth + 1, gcNode, start, duration, duration - stackChildrenDuration[stackTop]);
        --stackTop;
        prevNode = gcParentNode;
        prevId = prevNode.id;
        gcParentNode = null;
      }

      while (node && node.depth > prevNode.depth) {
        stackNodes.push(node);
        node = node.parent;
      }

      // Go down to the LCA and close current intervals.
      while (prevNode !== node) {
        const start = stackStartTimes[stackTop];
        const duration = sampleTime - start;
        stackChildrenDuration[stackTop - 1] += duration;
        closeFrameCallback(
            prevNode.depth, /** @type {!CPUProfileNode} */ (prevNode), start, duration,
            duration - stackChildrenDuration[stackTop]);
        --stackTop;
        if (node && node.depth === prevNode.depth) {
          stackNodes.push(node);
          node = node.parent;
        }
        prevNode = /** @type {!CPUProfileNode} */ (prevNode.parent);
      }

      // Go up the nodes stack and open new intervals.
      while (stackNodes.length) {
        const currentNode = /** @type {!CPUProfileNode} */ (stackNodes.pop());
        node = currentNode;
        openFrameCallback(currentNode.depth, currentNode, sampleTime);
        stackStartTimes[++stackTop] = sampleTime;
        stackChildrenDuration[stackTop] = 0;
      }

      prevId = id;
    }

    sampleTime = timestamps[sampleIndex] || this.profileEndTime;
    if (gcParentNode && idToNode.get(prevId) === gcNode) {
      const start = stackStartTimes[stackTop];
      const duration = sampleTime - start;
      stackChildrenDuration[stackTop - 1] += duration;
      closeFrameCallback(
          gcParentNode.depth + 1, /** @type {!CPUProfileNode} */ (node), start, duration,
          duration - stackChildrenDuration[stackTop]);
      --stackTop;
      prevId = gcParentNode.id;
    }

    for (let node = idToNode.get(prevId); node && node.parent; node = /** @type {!CPUProfileNode} */ (node.parent)) {
      const start = stackStartTimes[stackTop];
      const duration = sampleTime - start;
      stackChildrenDuration[stackTop - 1] += duration;
      closeFrameCallback(
          node.depth, /** @type {!CPUProfileNode} */ (node), start, duration,
          duration - stackChildrenDuration[stackTop]);
      --stackTop;
    }
  }

  /**
   * @param {number} index
   * @return {?CPUProfileNode}
   */
  nodeByIndex(index) {
    return this.samples && this._idToNode.get(this.samples[index]) || null;
  }
}
