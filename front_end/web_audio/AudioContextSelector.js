// Copyright 2019 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Common from '../common/common.js';
import * as i18n from '../i18n/i18n.js';
import * as UI from '../ui/ui.js';

export const UIStrings = {
  /**
  *@description Text that shows there is no recording
  */
  noRecordings: '(no recordings)',
  /**
  *@description Label prefix for an audio context selection
  *@example {realtime (1e03ec)} PH1
  */
  audioContextS: 'Audio context: {PH1}',
};
const str_ = i18n.i18n.registerUIStrings('web_audio/AudioContextSelector.js', UIStrings);
const i18nString = i18n.i18n.getLocalizedString.bind(undefined, str_);

/**
 * @implements {UI.SoftDropDown.Delegate<!Protocol.WebAudio.BaseAudioContext>}
 */
export class AudioContextSelector extends Common.ObjectWrapper.ObjectWrapper {
  constructor() {
    super();

    /** @type {string} */
    this._placeholderText = i18nString(UIStrings.noRecordings);

    /** @type {!UI.ListModel.ListModel<!Protocol.WebAudio.BaseAudioContext>} */
    this._items = new UI.ListModel.ListModel();

    /** @type {!UI.SoftDropDown.SoftDropDown<!Protocol.WebAudio.BaseAudioContext>} */
    this._dropDown = new UI.SoftDropDown.SoftDropDown(this._items, this);
    this._dropDown.setPlaceholderText(this._placeholderText);

    this._toolbarItem = new UI.Toolbar.ToolbarItem(this._dropDown.element);
    this._toolbarItem.setEnabled(false);
    this._toolbarItem.setTitle(i18nString(UIStrings.audioContextS, {PH1: this._placeholderText}));
    this._items.addEventListener(UI.ListModel.Events.ItemsReplaced, this._onListItemReplaced, this);
    this._toolbarItem.element.classList.add('toolbar-has-dropdown');

    /** @type {?Protocol.WebAudio.BaseAudioContext} */
    this._selectedContext = null;
  }

  _onListItemReplaced() {
    const hasItems = Boolean(this._items.length);
    this._toolbarItem.setEnabled(hasItems);
    if (!hasItems) {
      this._toolbarItem.setTitle(i18nString(UIStrings.audioContextS, {PH1: this._placeholderText}));
    }
  }

  /**
   * @param {!Common.EventTarget.EventTargetEvent} event
   */
  contextCreated(event) {
    const context = /** @type {!Protocol.WebAudio.BaseAudioContext} */ (event.data);
    this._items.insert(this._items.length, context);

    // Select if this is the first item.
    if (this._items.length === 1) {
      this._dropDown.selectItem(context);
    }
  }

  /**
   * @param {!Common.EventTarget.EventTargetEvent} event
   */
  contextDestroyed(event) {
    const contextId = /** @type {!Protocol.WebAudio.GraphObjectId} */ (event.data);
    const contextIndex = this._items.findIndex(context => context.contextId === contextId);
    if (contextIndex > -1) {
      this._items.remove(contextIndex);
    }
  }

  /**
   * @param {!Common.EventTarget.EventTargetEvent} event
   */
  contextChanged(event) {
    const changedContext = /** @type {!Protocol.WebAudio.BaseAudioContext} */ (event.data);
    const contextIndex = this._items.findIndex(context => context.contextId === changedContext.contextId);
    if (contextIndex > -1) {
      this._items.replace(contextIndex, changedContext);

      // If the changed context is currently selected by user. Re-select it
      // because the actual element is replaced with a new one.
      if (this._selectedContext && this._selectedContext.contextId === changedContext.contextId) {
        this._dropDown.selectItem(changedContext);
      }
    }
  }

  /**
   * @override
   * @param {!Protocol.WebAudio.BaseAudioContext} item
   * @return {!Element}
   */
  createElementForItem(item) {
    const element = document.createElement('div');
    const shadowRoot = UI.Utils.createShadowRootWithCoreStyles(
        element,
        {cssFile: 'web_audio/audioContextSelector.css', enableLegacyPatching: false, delegatesFocus: undefined});
    const title = shadowRoot.createChild('div', 'title');
    UI.UIUtils.createTextChild(title, this.titleFor(item).trimEndWithMaxLength(100));
    return element;
  }

  /**
   * @return {?Protocol.WebAudio.BaseAudioContext}
   */
  selectedContext() {
    if (!this._selectedContext) {
      return null;
    }

    return this._selectedContext;
  }

  /**
   * @override
   * @param {?Protocol.WebAudio.BaseAudioContext} from
   * @param {?Protocol.WebAudio.BaseAudioContext} to
   * @param {?Element} fromElement
   * @param {?Element} toElement
   */
  highlightedItemChanged(from, to, fromElement, toElement) {
    if (fromElement) {
      fromElement.classList.remove('highlighted');
    }
    if (toElement) {
      toElement.classList.add('highlighted');
    }
  }

  /**
   * @override
   * @param {!Protocol.WebAudio.BaseAudioContext} item
   * @return {boolean}
   */
  isItemSelectable(item) {
    return true;
  }

  /**
   * @override
   * @param {?Protocol.WebAudio.BaseAudioContext} item
   */
  itemSelected(item) {
    if (!item) {
      return;
    }

    // It's possible that no context is selected yet.
    if (!this._selectedContext || this._selectedContext.contextId !== item.contextId) {
      this._selectedContext = item;
      this._toolbarItem.setTitle(i18nString(UIStrings.audioContextS, {PH1: this.titleFor(item)}));
    }

    this.dispatchEventToListeners(Events.ContextSelected, item);
  }

  reset() {
    this._items.replaceAll([]);
  }

  /**
   * @override
   * @param {!Protocol.WebAudio.BaseAudioContext} context
   * @return {string}
   */
  titleFor(context) {
    return `${context.contextType} (${context.contextId.substr(-6)})`;
  }

  /**
   * @return {!UI.Toolbar.ToolbarItem}
   */
  toolbarItem() {
    return this._toolbarItem;
  }
}

/** @enum {symbol} */
export const Events = {
  ContextSelected: Symbol('ContextSelected')
};
