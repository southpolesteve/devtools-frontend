// Copyright 2018 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Bindings from '../bindings/bindings.js';
import * as ColorPicker from '../color_picker/color_picker.js';
import * as Common from '../common/common.js';
import * as Host from '../host/host.js';
import * as InlineEditor from '../inline_editor/inline_editor.js';
import * as Platform from '../platform/platform.js';
import * as SDK from '../sdk/sdk.js';
import * as TextUtils from '../text_utils/text_utils.js';
import * as UI from '../ui/ui.js';

import {BezierPopoverIcon, ColorSwatchPopoverIcon, ShadowSwatchPopoverHelper} from './ColorSwatchPopoverIcon.js';
import {CSSPropertyPrompt, StylePropertiesSection, StylesSidebarPane, StylesSidebarPropertyRenderer,} from './StylesSidebarPane.js';  // eslint-disable-line no-unused-vars

/** @type {!WeakMap<!StylesSidebarPane, !StylePropertyTreeElement>} */
const parentMap = new WeakMap();

export class StylePropertyTreeElement extends UI.TreeOutline.TreeElement {
  /**
   * @param {!StylesSidebarPane} stylesPane
   * @param {!SDK.CSSMatchedStyles.CSSMatchedStyles} matchedStyles
   * @param {!SDK.CSSProperty.CSSProperty} property
   * @param {boolean} isShorthand
   * @param {boolean} inherited
   * @param {boolean} overloaded
   * @param {boolean} newProperty
   */
  constructor(stylesPane, matchedStyles, property, isShorthand, inherited, overloaded, newProperty) {
    // Pass an empty title, the title gets made later in onattach.
    super('', isShorthand);
    this._style = property.ownerStyle;
    this._matchedStyles = matchedStyles;
    this.property = property;
    this._inherited = inherited;
    this._overloaded = overloaded;
    this.selectable = false;
    this._parentPane = stylesPane;
    this.isShorthand = isShorthand;
    this._applyStyleThrottler = new Common.Throttler.Throttler(0);
    this._newProperty = newProperty;
    if (this._newProperty) {
      this.listItemElement.textContent = '';
    }
    this._expandedDueToFilter = false;
    /** @type {?HTMLElement} */
    this.valueElement = null;
    /** @type {?HTMLElement} */
    this.nameElement = null;
    this._expandElement = null;
    this._originalPropertyText = '';
    this._hasBeenEditedIncrementally = false;
    this._prompt = null;

    /** @type {string|null} */
    this._lastComputedValue = null;
    /** @type {(!Context|undefined)} */
    this._contextForTest;
  }

  /**
   * @return {!SDK.CSSMatchedStyles.CSSMatchedStyles}
   */
  matchedStyles() {
    return this._matchedStyles;
  }

  /**
   * @return {boolean}
   */
  _editable() {
    return Boolean(this._style.styleSheetId && this._style.range);
  }

  /**
   * @return {boolean}
   */
  inherited() {
    return this._inherited;
  }

  /**
   * @return {boolean}
   */
  overloaded() {
    return this._overloaded;
  }

  /**
   * @param {boolean} x
   */
  setOverloaded(x) {
    if (x === this._overloaded) {
      return;
    }
    this._overloaded = x;
    this._updateState();
  }

  get name() {
    return this.property.name;
  }

  get value() {
    return this.property.value;
  }

  /**
   * @return {boolean}
   */
  updateFilter() {
    const regex = this._parentPane.filterRegex();
    const matches = regex !== null && (regex.test(this.property.name) || regex.test(this.property.value));
    this.listItemElement.classList.toggle('filter-match', matches);

    this.onpopulate();
    let hasMatchingChildren = false;

    for (let i = 0; i < this.childCount(); ++i) {
      const child = /** @type {?StylePropertyTreeElement} */ (this.childAt(i));
      if (!child || (child && !child.updateFilter())) {
        continue;
      }
      hasMatchingChildren = true;
    }

    if (!regex) {
      if (this._expandedDueToFilter) {
        this.collapse();
      }
      this._expandedDueToFilter = false;
    } else if (hasMatchingChildren && !this.expanded) {
      this.expand();
      this._expandedDueToFilter = true;
    } else if (!hasMatchingChildren && this.expanded && this._expandedDueToFilter) {
      this.collapse();
      this._expandedDueToFilter = false;
    }
    return matches;
  }

  /**
   * @param {string} text
   * @param {?Node=} valueChild
   * @return {!Node}
   */
  _processColor(text, valueChild) {
    const useUserSettingFormat = this._editable();
    const shiftClickMessage = Common.UIString.UIString('Shift + Click to change color format.');
    const tooltip =
        this._editable() ? Common.UIString.UIString('Open color picker. %s', shiftClickMessage) : shiftClickMessage;

    const swatch = new InlineEditor.ColorSwatch.ColorSwatch();
    swatch.renderColor(text, useUserSettingFormat, tooltip);

    if (!valueChild) {
      valueChild = swatch.createChild('span');
      valueChild.textContent = swatch.color ? swatch.color.asString(swatch.format) : text;
    }
    swatch.appendChild(valueChild);

    /** @param {!Event} event */
    const onFormatchanged = event => {
      const {data} = /** @type {*} */ (event);
      swatch.firstElementChild && swatch.firstElementChild.remove();
      swatch.createChild('span').textContent = data.text;
    };

    swatch.addEventListener('format-changed', onFormatchanged);

    if (this._editable()) {
      this._addColorContrastInfo(swatch);
    }

    return swatch;
  }

  /**
   * @param {string} text
   * @return {!Node}
   */
  _processVar(text) {
    const computedSingleValue = this._matchedStyles.computeSingleVariableValue(this._style, text);
    if (!computedSingleValue) {
      throw new Error('Unable to compute single value');
    }
    const {computedValue, fromFallback} = computedSingleValue;

    const varSwatch = new InlineEditor.CSSVarSwatch.CSSVarSwatch();
    UI.UIUtils.createTextChild(varSwatch, text);
    varSwatch.data = {text, computedValue, fromFallback, onLinkClick: this._handleVarDefinitionClick.bind(this)};

    if (!computedValue || !Common.Color.Color.parse(computedValue)) {
      return varSwatch;
    }

    return this._processColor(computedValue, varSwatch);
  }

  /**
   * @param {string} variableName
   * @param {!MouseEvent} event
   */
  _handleVarDefinitionClick(variableName, event) {
    if (event.button !== 0) {
      return;
    }

    Host.userMetrics.actionTaken(Host.UserMetrics.Action.CustomPropertyLinkClicked);
    this._parentPane.jumpToProperty(variableName);
    event.consume(true);
  }

  /**
   * @param {!InlineEditor.ColorSwatch.ColorSwatch} swatch
   */
  async _addColorContrastInfo(swatch) {
    const swatchPopoverHelper = this._parentPane.swatchPopoverHelper();
    const swatchIcon = new ColorSwatchPopoverIcon(this, swatchPopoverHelper, swatch);
    if (this.property.name !== 'color' || !this._parentPane.cssModel() || !this.node()) {
      return;
    }
    const cssModel = this._parentPane.cssModel();
    const node = this.node();
    if (cssModel && node && typeof node.id !== 'undefined') {
      const contrastInfo = new ColorPicker.ContrastInfo.ContrastInfo(await cssModel.backgroundColorsPromise(node.id));
      swatchIcon.setContrastInfo(contrastInfo);
    }
  }

  /**
   * @return {string}
   */
  renderedPropertyText() {
    if (!this.nameElement || !this.valueElement) {
      return '';
    }
    return this.nameElement.textContent + ': ' + this.valueElement.textContent;
  }

  /**
   * @param {string} text
   * @return {!Node}
   */
  _processBezier(text) {
    if (!this._editable() || !UI.Geometry.CubicBezier.parse(text)) {
      return document.createTextNode(text);
    }
    const swatchPopoverHelper = this._parentPane.swatchPopoverHelper();
    const swatch = InlineEditor.Swatches.BezierSwatch.create();
    swatch.setBezierText(text);
    new BezierPopoverIcon(this, swatchPopoverHelper, swatch);
    return swatch;
  }

  /**
   * @param {string} text
   * @return {!Node}
   */
  _processFont(text) {
    const section = this.section();
    if (section) {
      section.registerFontProperty(this);
    }
    return document.createTextNode(text);
  }

  /**
   * @param {string} propertyValue
   * @param {string} propertyName
   * @return {!Node}
   */
  _processShadow(propertyValue, propertyName) {
    if (!this._editable()) {
      return document.createTextNode(propertyValue);
    }
    let shadows;
    if (propertyName === 'text-shadow') {
      shadows = InlineEditor.CSSShadowModel.CSSShadowModel.parseTextShadow(propertyValue);
    } else {
      shadows = InlineEditor.CSSShadowModel.CSSShadowModel.parseBoxShadow(propertyValue);
    }
    if (!shadows.length) {
      return document.createTextNode(propertyValue);
    }
    const container = document.createDocumentFragment();
    const swatchPopoverHelper = this._parentPane.swatchPopoverHelper();
    for (let i = 0; i < shadows.length; i++) {
      if (i !== 0) {
        container.appendChild(document.createTextNode(', '));
      }  // Add back commas and spaces between each shadow.
      // TODO(flandy): editing the property value should use the original value with all spaces.
      const cssShadowSwatch = InlineEditor.Swatches.CSSShadowSwatch.create();
      cssShadowSwatch.setCSSShadow(shadows[i]);
      new ShadowSwatchPopoverHelper(this, swatchPopoverHelper, cssShadowSwatch);
      const colorSwatch = cssShadowSwatch.colorSwatch();
      if (colorSwatch) {
        new ColorSwatchPopoverIcon(this, swatchPopoverHelper, colorSwatch);
      }
      container.appendChild(cssShadowSwatch);
    }
    return container;
  }

  /**
   * @param {string} propertyValue
   * @param {string} propertyName
   * @return {!Node}
   */
  _processGrid(propertyValue, propertyName) {
    const splitResult =
        TextUtils.TextUtils.Utils.splitStringByRegexes(propertyValue, [SDK.CSSMetadata.GridAreaRowRegex]);
    if (splitResult.length <= 1) {
      return document.createTextNode(propertyValue);
    }

    const indent = Common.Settings.Settings.instance().moduleSetting('textEditorIndent').get();
    const container = document.createDocumentFragment();
    for (const result of splitResult) {
      const value = result.value.trim();
      const content = UI.Fragment.html`<br /><span class='styles-clipboard-only'>${indent.repeat(2)}</span>${value}`;
      container.appendChild(content);
    }
    return container;
  }

  /**
   * @param {string} angleText
   */
  _processAngle(angleText) {
    if (!this._editable()) {
      return document.createTextNode(angleText);
    }
    const cssAngle = new InlineEditor.CSSAngle.CSSAngle();
    const valueElement = document.createElement('span');
    valueElement.textContent = angleText;
    const computedPropertyValue = this._matchedStyles.computeValue(this.property.ownerStyle, this.property.value) || '';
    cssAngle.data = {
      propertyName: this.property.name,
      propertyValue: computedPropertyValue,
      angleText,
      containingPane:
          /** @type {!HTMLElement} */ (this._parentPane.element.enclosingNodeOrSelfWithClass('style-panes-wrapper')),
    };
    cssAngle.append(valueElement);

    /**
     * @param {!Event} event
     */
    const popoverToggled = event => {
      const section = this.section();
      if (!section) {
        return;
      }

      const {data} = /** @type {*} */ (event);
      if (data.open) {
        this._parentPane.hideAllPopovers();
        this._parentPane.activeCSSAngle = cssAngle;
      }

      section.element.classList.toggle('has-open-popover', data.open);
      this._parentPane.setEditingStyle(data.open);
    };

    /**
     * @param {!Event} event
     */
    const valueChanged = async event => {
      const {data} = /** @type {*} */ (event);

      valueElement.textContent = data.value;
      await this.applyStyleText(this.renderedPropertyText(), false);
      const computedPropertyValue =
          this._matchedStyles.computeValue(this.property.ownerStyle, this.property.value) || '';
      cssAngle.updateProperty(this.property.name, computedPropertyValue);
    };

    /**
     * @param {!Event} event
     */
    const unitChanged = async event => {
      const {data} = /** @type {*} */ (event);
      valueElement.textContent = data.value;
    };

    cssAngle.addEventListener('popover-toggled', popoverToggled);
    cssAngle.addEventListener('value-changed', valueChanged);
    cssAngle.addEventListener('unit-changed', unitChanged);

    return cssAngle;
  }

  _updateState() {
    if (!this.listItemElement) {
      return;
    }

    if (this._style.isPropertyImplicit(this.name)) {
      this.listItemElement.classList.add('implicit');
    } else {
      this.listItemElement.classList.remove('implicit');
    }

    const hasIgnorableError = !this.property.parsedOk && StylesSidebarPane.ignoreErrorsForProperty(this.property);
    if (hasIgnorableError) {
      this.listItemElement.classList.add('has-ignorable-error');
    } else {
      this.listItemElement.classList.remove('has-ignorable-error');
    }

    if (this.inherited()) {
      this.listItemElement.classList.add('inherited');
    } else {
      this.listItemElement.classList.remove('inherited');
    }

    if (this.overloaded()) {
      this.listItemElement.classList.add('overloaded');
    } else {
      this.listItemElement.classList.remove('overloaded');
    }

    if (this.property.disabled) {
      this.listItemElement.classList.add('disabled');
    } else {
      this.listItemElement.classList.remove('disabled');
    }
  }

  /**
   * @return {?SDK.DOMModel.DOMNode}
   */
  node() {
    return this._parentPane.node();
  }

  /**
   * @return {!StylesSidebarPane}
   */
  parentPane() {
    return this._parentPane;
  }

  /**
   * @return {?StylePropertiesSection}
   */
  section() {
    if (!this.treeOutline) {
      return null;
    }
    return /** @type {*} */ (this.treeOutline).section;
  }

  _updatePane() {
    const section = this.section();
    if (section) {
      section.refreshUpdate(this);
    }
  }

  /**
   * @param {boolean} disabled
   */
  async _toggleDisabled(disabled) {
    const oldStyleRange = this._style.range;
    if (!oldStyleRange) {
      return;
    }

    this._parentPane.setUserOperation(true);
    const success = await this.property.setDisabled(disabled);
    this._parentPane.setUserOperation(false);

    if (!success) {
      return;
    }
    this._matchedStyles.resetActiveProperties();
    this._updatePane();
    this.styleTextAppliedForTest();
  }

  /**
   * @override
   * @returns {!Promise<void>}
   */
  async onpopulate() {
    // Only populate once and if this property is a shorthand.
    if (this.childCount() || !this.isShorthand) {
      return;
    }

    const longhandProperties = this._style.longhandProperties(this.name);
    const leadingProperties = this._style.leadingProperties();

    for (let i = 0; i < longhandProperties.length; ++i) {
      const name = longhandProperties[i].name;
      let inherited = false;
      let overloaded = false;

      const section = this.section();
      if (section) {
        inherited = section.isPropertyInherited(name);
        overloaded =
            this._matchedStyles.propertyState(longhandProperties[i]) === SDK.CSSMatchedStyles.PropertyState.Overloaded;
      }

      const leadingProperty = leadingProperties.find(property => property.name === name && property.activeInStyle());
      if (leadingProperty) {
        overloaded = true;
      }

      const item = new StylePropertyTreeElement(
          this._parentPane, this._matchedStyles, longhandProperties[i], false, inherited, overloaded, false);
      this.appendChild(item);
    }
  }

  /**
   * @override
   */
  onattach() {
    this.updateTitle();

    this.listItemElement.addEventListener('mousedown', event => {
      if (event.button === 0) {
        parentMap.set(this._parentPane, this);
      }
    }, false);
    this.listItemElement.addEventListener('mouseup', this._mouseUp.bind(this));
    this.listItemElement.addEventListener('click', event => {
      if (!event.target) {
        return;
      }

      const node = /** @type {!HTMLElement} */ (event.target);
      if (!node.hasSelection() && event.target !== this.listItemElement) {
        event.consume(true);
      }
    });

    // Copy context menu.
    this.listItemElement.addEventListener('contextmenu', this._handleCopyContextMenuEvent.bind(this));
  }

  /**
   * @override
   */
  onexpand() {
    this._updateExpandElement();
  }

  /**
   * @override
   */
  oncollapse() {
    this._updateExpandElement();
  }

  _updateExpandElement() {
    if (!this._expandElement) {
      return;
    }
    if (this.expanded) {
      this._expandElement.setIconType('smallicon-triangle-down');
    } else {
      this._expandElement.setIconType('smallicon-triangle-right');
    }
  }

  updateTitleIfComputedValueChanged() {
    const computedValue = this._matchedStyles.computeValue(this.property.ownerStyle, this.property.value);
    if (computedValue === this._lastComputedValue) {
      return;
    }
    this._lastComputedValue = computedValue;
    this._innerUpdateTitle();
  }

  updateTitle() {
    this._lastComputedValue = this._matchedStyles.computeValue(this.property.ownerStyle, this.property.value);
    this._innerUpdateTitle();
  }

  _innerUpdateTitle() {
    this._updateState();
    if (this.isExpandable()) {
      this._expandElement = UI.Icon.Icon.create('smallicon-triangle-right', 'expand-icon');
    } else {
      this._expandElement = null;
    }

    const propertyRenderer =
        new StylesSidebarPropertyRenderer(this._style.parentRule, this.node(), this.name, this.value);
    if (this.property.parsedOk) {
      propertyRenderer.setVarHandler(this._processVar.bind(this));
      propertyRenderer.setColorHandler(this._processColor.bind(this));
      propertyRenderer.setBezierHandler(this._processBezier.bind(this));
      propertyRenderer.setFontHandler(this._processFont.bind(this));
      propertyRenderer.setShadowHandler(this._processShadow.bind(this));
      propertyRenderer.setGridHandler(this._processGrid.bind(this));
      propertyRenderer.setAngleHandler(this._processAngle.bind(this));
    }

    this.listItemElement.removeChildren();
    this.nameElement = /** @type {!HTMLElement} */ (propertyRenderer.renderName());
    if (this.property.name.startsWith('--') && this.nameElement) {
      UI.Tooltip.Tooltip.install(
          this.nameElement, this._matchedStyles.computeCSSVariable(this._style, this.property.name) || '');
    }
    this.valueElement = /** @type {!HTMLElement} */ (propertyRenderer.renderValue());
    if (!this.treeOutline) {
      return;
    }

    const indent = Common.Settings.Settings.instance().moduleSetting('textEditorIndent').get();
    UI.UIUtils.createTextChild(
        this.listItemElement.createChild('span', 'styles-clipboard-only'),
        indent + (this.property.disabled ? '/* ' : ''));
    if (this.nameElement) {
      this.listItemElement.appendChild(this.nameElement);
    }
    if (this.valueElement) {
      const lineBreakValue =
          this.valueElement.firstElementChild && this.valueElement.firstElementChild.tagName === 'BR';
      const separator = lineBreakValue ? ':' : ': ';
      this.listItemElement.createChild('span', 'styles-name-value-separator').textContent = separator;
      if (this._expandElement) {
        this.listItemElement.appendChild(this._expandElement);
      }
      this.listItemElement.appendChild(this.valueElement);
      UI.UIUtils.createTextChild(this.listItemElement, ';');
      if (this.property.disabled) {
        UI.UIUtils.createTextChild(this.listItemElement.createChild('span', 'styles-clipboard-only'), ' */');
      }
    }

    if (!this.property.parsedOk) {
      // Avoid having longhands under an invalid shorthand.
      this.listItemElement.classList.add('not-parsed-ok');

      // Add a separate exclamation mark IMG element with a tooltip.
      this.listItemElement.insertBefore(
          StylesSidebarPane.createExclamationMark(this.property, null), this.listItemElement.firstChild);
    } else {
      this._updateFontVariationSettingsWarning();
    }

    if (!this.property.activeInStyle()) {
      this.listItemElement.classList.add('inactive');
    }
    this.updateFilter();

    if (this.property.parsedOk && this.section() && this.parent && this.parent.root) {
      const enabledCheckboxElement = document.createElement('input');
      enabledCheckboxElement.className = 'enabled-button';
      enabledCheckboxElement.type = 'checkbox';
      enabledCheckboxElement.checked = !this.property.disabled;
      enabledCheckboxElement.addEventListener('mousedown', event => event.consume(), false);
      enabledCheckboxElement.addEventListener('click', event => {
        this._toggleDisabled(!this.property.disabled);
        event.consume();
      }, false);
      if (this.nameElement && this.valueElement) {
        UI.ARIAUtils.setAccessibleName(
            enabledCheckboxElement, `${this.nameElement.textContent} ${this.valueElement.textContent}`);
      }
      this.listItemElement.insertBefore(enabledCheckboxElement, this.listItemElement.firstChild);
    }
  }

  async _updateFontVariationSettingsWarning() {
    if (this.property.name !== 'font-variation-settings') {
      return;
    }
    const value = this.property.value;
    const cssModel = this._parentPane.cssModel();
    if (!cssModel) {
      return;
    }
    const computedStyleModel = this._parentPane.computedStyleModel();
    const styles = await computedStyleModel.fetchComputedStyle();
    if (!styles) {
      return;
    }
    const fontFamily = styles.computedStyle.get('font-family');
    if (!fontFamily) {
      return;
    }
    const fontFamilies = new Set(SDK.CSSPropertyParser.parseFontFamily(fontFamily));
    const matchingFontFaces = cssModel.fontFaces().filter(f => fontFamilies.has(f.getFontFamily()));
    const variationSettings = SDK.CSSPropertyParser.parseFontVariationSettings(value);
    const warnings = [];
    for (const elementSetting of variationSettings) {
      for (const font of matchingFontFaces) {
        const fontSetting = font.getVariationAxisByTag(elementSetting.tag);
        if (!fontSetting) {
          continue;
        }
        if (elementSetting.value < fontSetting.minValue || elementSetting.value > fontSetting.maxValue) {
          warnings.push(
              ls`Value for setting “${elementSetting.tag}” ${elementSetting.value} is outside the supported range [${
                  fontSetting.minValue}, ${fontSetting.maxValue}] for font-family “${font.getFontFamily()}”.`);
        }
      }
    }

    if (!warnings.length) {
      return;
    }
    this.listItemElement.classList.add('has-warning');
    this.listItemElement.insertBefore(
        StylesSidebarPane.createExclamationMark(this.property, warnings.join(' ')), this.listItemElement.firstChild);
  }

  /**
   * @param {!Event} event
   */
  _mouseUp(event) {
    const activeTreeElement = parentMap.get(this._parentPane);
    parentMap.delete(this._parentPane);
    if (!activeTreeElement) {
      return;
    }
    if (this.listItemElement.hasSelection()) {
      return;
    }
    if (UI.UIUtils.isBeingEdited(/** @type {!Node} */ (event.target))) {
      return;
    }

    event.consume(true);

    if (event.target === this.listItemElement) {
      return;
    }

    const section = this.section();
    if (UI.KeyboardShortcut.KeyboardShortcut.eventHasCtrlOrMeta(/** @type {!MouseEvent} */ (event)) && section &&
        section.navigable) {
      this._navigateToSource(/** @type {!Element} */ (event.target));
      return;
    }

    this.startEditing(/** @type {!Element} */ (event.target));
  }

  /**
   * @param {!Context} context
   * @param {!Event} event
   */
  _handleContextMenuEvent(context, event) {
    const contextMenu = new UI.ContextMenu.ContextMenu(event);
    if (this.property.parsedOk && this.section() && this.parent && this.parent.root) {
      contextMenu.defaultSection().appendCheckboxItem(ls`Toggle property and continue editing`, async () => {
        const sectionIndex = this._parentPane.focusedSectionIndex();
        if (this.treeOutline) {
          const propertyIndex = this.treeOutline.rootElement().indexOfChild(this);
          // order matters here: this.editingCancelled may invalidate this.treeOutline.
          this.editingCancelled(null, context);
          await this._toggleDisabled(!this.property.disabled);
          event.consume();
          this._parentPane.continueEditingElement(sectionIndex, propertyIndex);
        }
      }, !this.property.disabled);
    }
    const revealCallback = /** @type {function():*} */ (this._navigateToSource.bind(this));
    contextMenu.defaultSection().appendItem(ls`Reveal in Sources panel`, revealCallback);
    contextMenu.show();
  }

  /**
   * @param {!Event} event
   */
  _handleCopyContextMenuEvent(event) {
    const target = /** @type {?Element} */ (event.target);

    if (!target) {
      return;
    }

    const contextMenu = new UI.ContextMenu.ContextMenu(event);
    contextMenu.clipboardSection().appendItem(ls`Copy declaration`, () => {
      const propertyText = `${this.property.name}: ${this.property.value};`;
      Host.InspectorFrontendHost.InspectorFrontendHostInstance.copyText(propertyText);
    });

    contextMenu.clipboardSection().appendItem(ls`Copy property`, () => {
      Host.InspectorFrontendHost.InspectorFrontendHostInstance.copyText(this.property.name);
    });

    contextMenu.clipboardSection().appendItem(ls`Copy value`, () => {
      Host.InspectorFrontendHost.InspectorFrontendHostInstance.copyText(this.property.value);
    });

    contextMenu.defaultSection().appendItem(ls`Copy rule`, () => {
      const section = /** @type {!StylePropertiesSection} */ (this.section());
      const ruleText = StylesSidebarPane.formatLeadingProperties(section).ruleText;
      Host.InspectorFrontendHost.InspectorFrontendHostInstance.copyText(ruleText);
    });

    contextMenu.defaultSection().appendItem(ls`Copy all declarations`, () => {
      const section = /** @type {!StylePropertiesSection} */ (this.section());
      const allDeclarationText = StylesSidebarPane.formatLeadingProperties(section).allDeclarationText;
      Host.InspectorFrontendHost.InspectorFrontendHostInstance.copyText(allDeclarationText);
    });

    contextMenu.show();
  }

  /**
   * @param {!Element} element
   * @param {boolean=} omitFocus
   */
  _navigateToSource(element, omitFocus) {
    const section = this.section();
    if (!section || !section.navigable) {
      return;
    }
    const propertyNameClicked = element === this.nameElement;
    const uiLocation = Bindings.CSSWorkspaceBinding.CSSWorkspaceBinding.instance().propertyUILocation(
        this.property, propertyNameClicked);
    if (uiLocation) {
      Common.Revealer.reveal(uiLocation, omitFocus);
    }
  }

  /**
   * @param {?Element=} selectElement
   */
  startEditing(selectElement) {
    // FIXME: we don't allow editing of longhand properties under a shorthand right now.
    if (this.parent instanceof StylePropertyTreeElement && this.parent.isShorthand) {
      return;
    }

    if (this._expandElement && selectElement === this._expandElement) {
      return;
    }

    const section = this.section();
    if (section && !section.editable) {
      return;
    }

    if (selectElement) {
      selectElement = selectElement.enclosingNodeOrSelfWithClass('webkit-css-property') ||
          selectElement.enclosingNodeOrSelfWithClass('value');
    }
    if (!selectElement) {
      selectElement = this.nameElement;
    }

    if (UI.UIUtils.isBeingEdited(selectElement)) {
      return;
    }

    const isEditingName = selectElement === this.nameElement;
    if (!isEditingName && this.valueElement) {
      if (SDK.CSSMetadata.cssMetadata().isGridAreaDefiningProperty(this.name)) {
        this.valueElement.textContent = restoreGridIndents(this.value);
      }
      this.valueElement.textContent = restoreURLs(this.valueElement.textContent || '', this.value);
    }

    /**
     * @param {string} value
     */
    function restoreGridIndents(value) {
      const splitResult = TextUtils.TextUtils.Utils.splitStringByRegexes(value, [SDK.CSSMetadata.GridAreaRowRegex]);
      return splitResult.map(result => result.value.trim()).join('\n');
    }

    /**
     * @param {string} fieldValue
     * @param {string} modelValue
     * @return {string}
     */
    function restoreURLs(fieldValue, modelValue) {
      const splitFieldValue = fieldValue.split(SDK.CSSMetadata.URLRegex);
      if (splitFieldValue.length === 1) {
        return fieldValue;
      }
      const modelUrlRegex = new RegExp(SDK.CSSMetadata.URLRegex);
      for (let i = 1; i < splitFieldValue.length; i += 2) {
        const match = modelUrlRegex.exec(modelValue);
        if (match) {
          splitFieldValue[i] = match[0];
        }
      }
      return splitFieldValue.join('');
    }

    const previousContent = selectElement ? (selectElement.textContent || '') : '';

    /** @type {!Context} */
    const context = {
      expanded: this.expanded,
      hasChildren: this.isExpandable(),
      isEditingName: isEditingName,
      originalProperty: this.property,
      previousContent: previousContent,
      originalName: undefined,
      originalValue: undefined
    };
    this._contextForTest = context;

    // Lie about our children to prevent expanding on double click and to collapse shorthands.
    this.setExpandable(false);

    if (selectElement) {
      if (selectElement.parentElement) {
        selectElement.parentElement.classList.add('child-editing');
      }
      selectElement.textContent = selectElement.textContent;  // remove color swatch and the like
    }

    /**
     * @param {!Context} context
     * @param {!Event} event
     * @this {StylePropertyTreeElement}
     */
    function pasteHandler(context, event) {
      const clipboardEvent = /** @type {!ClipboardEvent} */ (event);
      const clipboardData = clipboardEvent.clipboardData;
      if (!clipboardData) {
        return;
      }

      const data = clipboardData.getData('Text');
      if (!data) {
        return;
      }
      const colonIdx = data.indexOf(':');
      if (colonIdx < 0) {
        return;
      }
      const name = data.substring(0, colonIdx).trim();
      const value = data.substring(colonIdx + 1).trim();

      event.preventDefault();

      if (typeof context.originalName === 'undefined') {
        if (this.nameElement) {
          context.originalName = this.nameElement.textContent || '';
        }

        if (this.valueElement) {
          context.originalValue = this.valueElement.textContent || '';
        }
      }
      this.property.name = name;
      this.property.value = value;
      if (this.nameElement) {
        this.nameElement.textContent = name;
        this.nameElement.normalize();
      }

      if (this.valueElement) {
        this.valueElement.textContent = value;
        this.valueElement.normalize();
      }

      const target = /** @type {!HTMLElement} */ (event.target);
      this._editingCommitted(target.textContent || '', context, 'forward');
    }

    /**
     * @param {!Context} context
     * @param {!Event} event
     * @this {StylePropertyTreeElement}
     */
    function blurListener(context, event) {
      const target = /** @type {!HTMLElement} */ (event.target);
      let text = target.textContent;
      if (!context.isEditingName) {
        text = this.value || text;
      }
      this._editingCommitted(text || '', context, '');
    }

    this._originalPropertyText = this.property.propertyText || '';

    this._parentPane.setEditingStyle(true, this);
    if (selectElement && selectElement.parentElement) {
      selectElement.parentElement.scrollIntoViewIfNeeded(false);
    }

    this._prompt = new CSSPropertyPrompt(this, isEditingName);
    this._prompt.setAutocompletionTimeout(0);

    this._prompt.addEventListener(UI.TextPrompt.Events.TextChanged, event => {
      this._applyFreeFlowStyleTextEdit(context);
    });

    if (selectElement) {
      const proxyElement = this._prompt.attachAndStartEditing(selectElement, blurListener.bind(this, context));
      this._navigateToSource(selectElement, true);

      proxyElement.addEventListener('keydown', this._editingNameValueKeyDown.bind(this, context), false);
      proxyElement.addEventListener('keypress', this._editingNameValueKeyPress.bind(this, context), false);
      if (isEditingName) {
        proxyElement.addEventListener('paste', pasteHandler.bind(this, context), false);
        proxyElement.addEventListener('contextmenu', this._handleContextMenuEvent.bind(this, context), false);
      }

      const componentSelection = selectElement.getComponentSelection();
      if (componentSelection) {
        componentSelection.selectAllChildren(selectElement);
      }
    }
  }

  /**
   * @param {!Context} context
   * @param {!Event} event
   */
  _editingNameValueKeyDown(context, event) {
    if (event.handled) {
      return;
    }

    const keyboardEvent = /** @type {!KeyboardEvent} */ (event);
    const target = /** @type {!HTMLElement} */ (keyboardEvent.target);
    let result;
    if (isEnterKey(keyboardEvent) && !keyboardEvent.shiftKey) {
      result = 'forward';
    } else if (keyboardEvent.keyCode === UI.KeyboardShortcut.Keys.Esc.code || keyboardEvent.key === 'Escape') {
      result = 'cancel';
    } else if (
        !context.isEditingName && this._newProperty &&
        keyboardEvent.keyCode === UI.KeyboardShortcut.Keys.Backspace.code) {
      // For a new property, when Backspace is pressed at the beginning of new property value, move back to the property name.
      const selection = target.getComponentSelection();
      if (selection && selection.isCollapsed && !selection.focusOffset) {
        event.preventDefault();
        result = 'backward';
      }
    } else if (keyboardEvent.key === 'Tab') {
      result = keyboardEvent.shiftKey ? 'backward' : 'forward';
      event.preventDefault();
    }

    if (result) {
      switch (result) {
        case 'cancel':
          this.editingCancelled(null, context);
          break;
        case 'forward':
        case 'backward':
          this._editingCommitted(target.textContent || '', context, result);
          break;
      }

      event.consume();
      return;
    }
  }

  /**
   * @param {!Context} context
   * @param {!Event} event
   */
  _editingNameValueKeyPress(context, event) {
    /**
     * @param {string} text
     * @param {number} cursorPosition
     * @return {boolean}
     */
    function shouldCommitValueSemicolon(text, cursorPosition) {
      // FIXME: should this account for semicolons inside comments?
      let openQuote = '';
      for (let i = 0; i < cursorPosition; ++i) {
        const ch = text[i];
        if (ch === '\\' && openQuote !== '') {
          ++i;
        }  // skip next character inside string
        else if (!openQuote && (ch === '"' || ch === '\'')) {
          openQuote = ch;
        } else if (openQuote === ch) {
          openQuote = '';
        }
      }
      return !openQuote;
    }

    const keyboardEvent = /** @type {!KeyboardEvent} */ (event);
    const target = /** @type {!HTMLElement} */ (keyboardEvent.target);
    const keyChar = String.fromCharCode(keyboardEvent.charCode);
    const selectionLeftOffset = target.selectionLeftOffset();
    const isFieldInputTerminated =
        (context.isEditingName ? keyChar === ':' :
                                 keyChar === ';' && selectionLeftOffset !== null &&
                 shouldCommitValueSemicolon(target.textContent || '', selectionLeftOffset));
    if (isFieldInputTerminated) {
      // Enter or colon (for name)/semicolon outside of string (for value).
      event.consume(true);
      this._editingCommitted(target.textContent || '', context, 'forward');
      return;
    }
  }

  /**
   * @param {!Context} context
   * @return {!Promise<void>}
   */
  async _applyFreeFlowStyleTextEdit(context) {
    if (!this._prompt || !this._parentPane.node()) {
      return;
    }

    const enteredText = this._prompt.text();
    if (context.isEditingName && enteredText.includes(':')) {
      this._editingCommitted(enteredText, context, 'forward');
      return;
    }

    const valueText = this._prompt.textWithCurrentSuggestion();
    if (valueText.includes(';')) {
      return;
    }
    // Prevent destructive side-effects during live-edit. crbug.com/433889
    const parentNode = this._parentPane.node();
    if (parentNode) {
      const isPseudo = Boolean(parentNode.pseudoType());
      if (isPseudo) {
        if (this.name.toLowerCase() === 'content') {
          return;
        }
        const lowerValueText = valueText.trim().toLowerCase();
        if (lowerValueText.startsWith('content:') || lowerValueText === 'display: none') {
          return;
        }
      }
    }

    if (context.isEditingName) {
      if (valueText.includes(':')) {
        await this.applyStyleText(valueText, false);
      } else if (this._hasBeenEditedIncrementally) {
        await this._applyOriginalStyle(context);
      }
    } else {
      if (this.nameElement) {
        await this.applyStyleText(`${this.nameElement.textContent}: ${valueText}`, false);
      }
    }
  }

  /**
   * @return {!Promise<void>}
   */
  kickFreeFlowStyleEditForTest() {
    const context = this._contextForTest;
    return this._applyFreeFlowStyleTextEdit(/** @type {!Context} */ (context));
  }

  /**
   * @param {!Context} context
   */
  editingEnded(context) {
    this.setExpandable(context.hasChildren);
    if (context.expanded) {
      this.expand();
    }
    const editedElement = context.isEditingName ? this.nameElement : this.valueElement;
    // The proxyElement has been deleted, no need to remove listener.
    if (editedElement && editedElement.parentElement) {
      editedElement.parentElement.classList.remove('child-editing');
    }

    this._parentPane.setEditingStyle(false);
  }

  /**
   * @param {?Element} element
   * @param {!Context} context
   */
  editingCancelled(element, context) {
    this._removePrompt();

    if (this._hasBeenEditedIncrementally) {
      this._applyOriginalStyle(context);
    } else if (this._newProperty && this.treeOutline) {
      this.treeOutline.removeChild(this);
    }
    this.updateTitle();

    // This should happen last, as it clears the info necessary to restore the property value after [Page]Up/Down changes.
    this.editingEnded(context);
  }

  /**
   * @param {!Context} context
   */
  async _applyOriginalStyle(context) {
    await this.applyStyleText(this._originalPropertyText, false, context.originalProperty);
  }

  /**
   * @param {string} moveDirection
   * @return {?StylePropertyTreeElement}
   */
  _findSibling(moveDirection) {
    /** @type {?StylePropertyTreeElement} */
    let target = this;
    do {
      /** @type {?UI.TreeOutline.TreeElement} */
      const sibling = moveDirection === 'forward' ? target.nextSibling : target.previousSibling;
      target = sibling instanceof StylePropertyTreeElement ? sibling : null;
    } while (target && target.inherited());

    return target;
  }

  /**
   * @param {string} userInput
   * @param {!Context} context
   * @param {string} moveDirection
   */
  async _editingCommitted(userInput, context, moveDirection) {
    this._removePrompt();
    this.editingEnded(context);
    const isEditingName = context.isEditingName;
    // If the underlying property has been ripped out, always assume that the value having been entered was
    // a name-value pair and attempt to process it via the SDK.
    if (!this.nameElement || !this.valueElement) {
      return;
    }

    const nameElementValue = this.nameElement.textContent || '';
    const nameValueEntered = (isEditingName && nameElementValue.includes(':')) || !this.property;

    // Determine where to move to before making changes
    let createNewProperty = false;
    let moveToSelector = false;
    const isDataPasted = typeof context.originalName !== 'undefined';
    const isDirtyViaPaste = isDataPasted &&
        (this.nameElement.textContent !== context.originalName ||
         this.valueElement.textContent !== context.originalValue);
    const isPropertySplitPaste =
        isDataPasted && isEditingName && this.valueElement.textContent !== context.originalValue;
    /** @type {?StylePropertyTreeElement} */
    let moveTo = this;
    const moveToOther = (isEditingName !== (moveDirection === 'forward'));
    const abandonNewProperty = this._newProperty && !userInput && (moveToOther || isEditingName);
    if (moveDirection === 'forward' && (!isEditingName || isPropertySplitPaste) ||
        moveDirection === 'backward' && isEditingName) {
      moveTo = moveTo._findSibling(moveDirection);
      if (!moveTo) {
        if (moveDirection === 'forward' && (!this._newProperty || userInput)) {
          createNewProperty = true;
        } else if (moveDirection === 'backward') {
          moveToSelector = true;
        }
      }
    }

    // Make the Changes and trigger the moveToNextCallback after updating.
    let moveToIndex = -1;
    if (moveTo !== null && this.treeOutline) {
      moveToIndex = this.treeOutline.rootElement().indexOfChild(/** @type {!UI.TreeOutline.TreeElement} */ (moveTo));
    }
    const blankInput = Platform.StringUtilities.isWhitespace(userInput);
    const shouldCommitNewProperty = this._newProperty &&
        (isPropertySplitPaste || moveToOther || (!moveDirection && !isEditingName) || (isEditingName && blankInput) ||
         nameValueEntered);
    const section = /** @type {!StylePropertiesSection} */ (this.section());
    if (((userInput !== context.previousContent || isDirtyViaPaste) && !this._newProperty) || shouldCommitNewProperty) {
      let propertyText;
      if (nameValueEntered) {
        propertyText = this.nameElement.textContent;
      } else if (
          blankInput ||
          (this._newProperty && Platform.StringUtilities.isWhitespace(this.valueElement.textContent || ''))) {
        propertyText = '';
      } else {
        if (isEditingName) {
          propertyText = userInput + ': ' + this.property.value;
        } else {
          propertyText = this.property.name + ': ' + userInput;
        }
      }
      await this.applyStyleText(propertyText || '', true);
      moveToNextCallback.call(this, this._newProperty, !blankInput, section);
    } else {
      if (isEditingName) {
        this.property.name = userInput;
      } else {
        this.property.value = userInput;
      }
      if (!isDataPasted && !this._newProperty) {
        this.updateTitle();
      }
      moveToNextCallback.call(this, this._newProperty, false, section);
    }

    /**
     * The Callback to start editing the next/previous property/selector.
     * @param {boolean} alreadyNew
     * @param {boolean} valueChanged
     * @param {!StylePropertiesSection} section
     * @this {StylePropertyTreeElement}
     */
    function moveToNextCallback(alreadyNew, valueChanged, section) {
      if (!moveDirection) {
        this._parentPane.resetFocus();
        return;
      }

      // User just tabbed through without changes.
      if (moveTo && moveTo.parent) {
        moveTo.startEditing(!isEditingName ? moveTo.nameElement : moveTo.valueElement);
        return;
      }

      // User has made a change then tabbed, wiping all the original treeElements.
      // Recalculate the new treeElement for the same property we were going to edit next.
      if (moveTo && !moveTo.parent) {
        const rootElement = section.propertiesTreeOutline.rootElement();
        if (moveDirection === 'forward' && blankInput && !isEditingName) {
          --moveToIndex;
        }
        if (moveToIndex >= rootElement.childCount() && !this._newProperty) {
          createNewProperty = true;
        } else {
          const treeElement =
              /** @type {?StylePropertyTreeElement} */ (moveToIndex >= 0 ? rootElement.childAt(moveToIndex) : null);
          if (treeElement) {
            let elementToEdit =
                !isEditingName || isPropertySplitPaste ? treeElement.nameElement : treeElement.valueElement;
            if (alreadyNew && blankInput) {
              elementToEdit = moveDirection === 'forward' ? treeElement.nameElement : treeElement.valueElement;
            }
            treeElement.startEditing(elementToEdit);
            return;
          }
          if (!alreadyNew) {
            moveToSelector = true;
          }
        }
      }

      // Create a new attribute in this section (or move to next editable selector if possible).
      if (createNewProperty) {
        if (alreadyNew && !valueChanged && (isEditingName !== (moveDirection === 'backward'))) {
          return;
        }

        section.addNewBlankProperty().startEditing();
        return;
      }

      if (abandonNewProperty) {
        moveTo = this._findSibling(moveDirection);
        const sectionToEdit = (moveTo || moveDirection === 'backward') ? section : section.nextEditableSibling();
        if (sectionToEdit) {
          if (sectionToEdit.style().parentRule) {
            sectionToEdit.startEditingSelector();
          } else {
            sectionToEdit.moveEditorFromSelector(moveDirection);
          }
        }
        return;
      }

      if (moveToSelector) {
        if (section.style().parentRule) {
          section.startEditingSelector();
        } else {
          section.moveEditorFromSelector(moveDirection);
        }
      }
    }
  }

  _removePrompt() {
    // BUG 53242. This cannot go into editingEnded(), as it should always happen first for any editing outcome.
    if (this._prompt) {
      this._prompt.detach();
      this._prompt = null;
    }
  }

  styleTextAppliedForTest() {
  }

  /**
   * @param {string} styleText
   * @param {boolean} majorChange
   * @param {?SDK.CSSProperty.CSSProperty=} property
   * @return {!Promise<void>}
   */
  applyStyleText(styleText, majorChange, property) {
    return this._applyStyleThrottler.schedule(this._innerApplyStyleText.bind(this, styleText, majorChange, property));
  }

  /**
   * @param {string} styleText
   * @param {boolean} majorChange
   * @param {?SDK.CSSProperty.CSSProperty=} property
   * @return {!Promise<void>}
   */
  async _innerApplyStyleText(styleText, majorChange, property) {
    // this.property might have been nulled at the end of the last _innerApplyStyleText
    if (!this.treeOutline || !this.property) {
      return;
    }

    const oldStyleRange = this._style.range;
    if (!oldStyleRange) {
      return;
    }

    const hasBeenEditedIncrementally = this._hasBeenEditedIncrementally;
    styleText = styleText.replace(/[\xA0\t]/g, ' ').trim();  // Replace &nbsp; with whitespace.
    if (!styleText.length && majorChange && this._newProperty && !hasBeenEditedIncrementally) {
      // The user deleted everything and never applied a new property value via Up/Down scrolling/live editing, so remove the tree element and update.
      this.parent && this.parent.removeChild(this);
      return;
    }

    const currentNode = this._parentPane.node();
    this._parentPane.setUserOperation(true);

    // Append a ";" if the new text does not end in ";".
    // FIXME: this does not handle trailing comments.
    if (styleText.length && !/;\s*$/.test(styleText)) {
      styleText += ';';
    }
    const overwriteProperty = !this._newProperty || hasBeenEditedIncrementally;
    let success = await this.property.setText(styleText, majorChange, overwriteProperty);
    // Revert to the original text if applying the new text failed
    if (hasBeenEditedIncrementally && majorChange && !success) {
      majorChange = false;
      success = await this.property.setText(this._originalPropertyText, majorChange, overwriteProperty);
    }
    this._parentPane.setUserOperation(false);

    // TODO: using this.property.index to access its containing StyleDeclaration's property will result in
    // off-by-1 errors when the containing StyleDeclaration's respective property has already been deleted.
    // These referencing logic needs to be updated to be more robust.
    const updatedProperty = property || this._style.propertyAt(this.property.index);
    const isPropertyWithinBounds = this.property.index < this._style.allProperties().length;
    if (!success || (!updatedProperty && isPropertyWithinBounds)) {
      if (majorChange) {
        // It did not apply, cancel editing.
        if (this._newProperty) {
          this.treeOutline.removeChild(this);
        } else {
          this.updateTitle();
        }
      }
      this.styleTextAppliedForTest();
      return;
    }

    this._matchedStyles.resetActiveProperties();
    this._hasBeenEditedIncrementally = true;

    // null check for updatedProperty before setting this.property as the code never expects this.property to be undefined or null.
    // This occurs when deleting the last index of a StylePropertiesSection as this._style._allProperties array gets updated
    // before we index it when setting the value for updatedProperty
    const deleteProperty = majorChange && !styleText.length;
    const section = this.section();
    if (deleteProperty && section) {
      section.resetToolbars();
    } else if (!deleteProperty && updatedProperty) {
      this.property = updatedProperty;
    }

    if (currentNode === this.node()) {
      this._updatePane();
    }

    this.styleTextAppliedForTest();
  }

  /**
   * @override
   * @return {boolean}
   */
  ondblclick() {
    return true;  // handled
  }

  /**
   * @override
   * @param {!Event} event
   * @return {boolean}
   */
  isEventWithinDisclosureTriangle(event) {
    return event.target === this._expandElement;
  }
}

/** @typedef {{
 *    expanded: boolean,
 *    hasChildren: boolean,
 *    isEditingName: boolean,
 *    originalProperty: (!SDK.CSSProperty.CSSProperty|undefined),
 *    originalName: (string|undefined),
 *    originalValue: (string|undefined),
 *    previousContent: string
 *  }}
 */
// @ts-ignore Typedef
export let Context;
