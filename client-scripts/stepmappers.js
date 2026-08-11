(function (root, factory) {
  var api = factory();
  root.LegacyAIBindingEngine = api;
  root.legacyAIBindingEngine = api;

  if (root.document) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', function () {
        api.init();
      });
    } else {
      api.init();
    }
  }
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  function normalizeText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .replace(/\s*([,:;.-])\s*/g, '$1 ')
      .trim();
  }

  function getStorageKey() {
    var locationRef = typeof window !== 'undefined' && window.location ? window.location : null;
    if (!locationRef) return 'legacy-ai-binding:default';
    return 'legacy-ai-binding:' + locationRef.origin + locationRef.pathname + locationRef.search;
  }

  function getStorage() {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        return window.localStorage;
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  function readPersistedState() {
    var storage = getStorage();
    if (!storage) return null;
    try {
      return JSON.parse(storage.getItem(getStorageKey()) || 'null');
    } catch (error) {
      return null;
    }
  }

  function writePersistedState(state) {
    var storage = getStorage();
    if (!storage) return;
    try {
      storage.setItem(getStorageKey(), JSON.stringify(state));
    } catch (error) {
      // Ignore storage failures in private or restricted contexts.
    }
  }

  function persistCurrentFormState(rootNode) {
    var state = {
      page: typeof window !== 'undefined' && window.location ? window.location.href : '',
      timestamp: Date.now(),
      fields: captureCurrentFormState(rootNode || document).map(function (field) {
        return {
          name: field.name,
          domIndex: field.domIndex,
          label: field.label,
          value: field.currentValue
        };
      })
    };
    writePersistedState(state);
    return state;
  }

  function restorePersistedValues(rootNode) {
    var state = readPersistedState();
    if (!state || !state.fields || !state.fields.length) return false;

    var actions = state.fields.map(function (field) {
      return {
        name: field.name,
        domIndex: field.domIndex,
        value: field.value
      };
    });

    applyAIBindings(actions);
    return true;
  }

  function isHiddenElement(element) {
    if (!element) return true;
    if (element.hidden) return true;
    if (element.type && element.type.toLowerCase() === 'hidden') return true;
    if (element.offsetParent === null && element.getClientRects().length === 0 && !element.getAttribute('aria-hidden')) {
      return true;
    }
    return false;
  }

  function getElementType(element) {
    if (!element) return 'unknown';
    if (element.tagName && element.tagName.toLowerCase() === 'input') {
      return (element.type || 'text').toLowerCase();
    }
    return element.tagName ? element.tagName.toLowerCase() : 'unknown';
  }

  function collectReadableText(node) {
    if (!node) return '';
    if (node.nodeType === 3) {
      return node.textContent || '';
    }

    if (node.nodeType !== 1) return '';

    var skipTags = /^(script|style|noscript|svg|img|button|input|select|textarea)$/i;
    if (skipTags.test(node.tagName)) return '';

    var text = '';
    var child = node.firstChild;
    while (child) {
      text += collectReadableText(child);
      child = child.nextSibling;
    }
    return text;
  }

  function inferLabel(element) {
    if (!element) return '';

    // 1) Explicit accessibility hints are usually the best starting point.
    var explicitLabel = normalizeText(
      element.getAttribute('aria-label') ||
      element.getAttribute('title') ||
      element.getAttribute('placeholder') ||
      ''
    );
    if (explicitLabel) return explicitLabel;

    // 2) Look for a matching label element using the for= attribute.
    var id = element.id;
    var name = element.name;
    var labels = element.ownerDocument.querySelectorAll('label');
    for (var i = 0; i < labels.length; i++) {
      var label = labels[i];
      var forValue = normalizeText(label.getAttribute('for') || '');
      if ((id && forValue && forValue === id) || (name && forValue && forValue === name)) {
        var labelText = normalizeText(label.textContent || '');
        if (labelText) return labelText;
      }
    }

    // 3) Heuristic proximity parsing for legacy markup.
    // We inspect nearby containers like div, td, tr, .form-group, .field, .control-group.
    var parent = element.parentElement;
    var depth = 0;
    while (parent && depth < 6) {
      if (parent.tagName && /^(LABEL|TD|TH|TR|DIV|SECTION|FIELDSET|P|LI)$/i.test(parent.tagName)) {
        var text = normalizeText(collectReadableText(parent));
        if (text && text.length < 120 && !/^(submit|cancel|ok|clear)$/i.test(text)) {
          return text;
        }
      }

      if (parent.className && /form-group|field|control-group|input-group|form-row|form-element|fieldset/i.test(parent.className)) {
        var groupText = normalizeText(collectReadableText(parent));
        if (groupText && groupText.length < 140) return groupText;
      }

      parent = parent.parentElement;
      depth += 1;
    }

    // 4) If the field has a meaningful name, use that as a fallback label.
    if (name) return normalizeText(name.replace(/[_-]+/g, ' '));

    return '';
  }

  function getCurrentValue(element) {
    if (!element) return '';
    var tagName = element.tagName ? element.tagName.toLowerCase() : '';
    var type = (element.type || '').toLowerCase();

    if (type === 'checkbox' || type === 'radio') {
      return element.checked;
    }

    if (tagName === 'select') {
      return element.value;
    }

    return element.value;
  }

  function getSelectOptions(element) {
    if (!element || element.tagName.toLowerCase() !== 'select') return [];
    var options = [];
    for (var i = 0; i < element.options.length; i++) {
      var option = element.options[i];
      if (option.textContent) {
        options.push(normalizeText(option.textContent));
      }
    }
    return options;
  }

  function getGroupKey(element) {
    if (!element) return null;
    var dataId = element.getAttribute && element.getAttribute('data-id');
    if (dataId) return 'data-id:' + dataId;
    var name = element.getAttribute && element.getAttribute('name');
    if (name) return 'name:' + name.replace(/_\d+$/i, '');
    var id = element.getAttribute && element.getAttribute('id');
    if (id) return 'id:' + id.replace(/_\d+$/i, '');
    return null;
  }

  function inferGroupLabel(element) {
    if (!element) return '';

    var current = element;
    while (current && current.parentElement) {
      var row = current.parentElement.closest && current.parentElement.closest('tr');
      if (row) {
        var cells = row.querySelectorAll('th, td');
        var targetFound = false;

        for (var i = 0; i < cells.length; i++) {
          var cell = cells[i];
          if (cell && cell.contains && cell.contains(element)) {
            targetFound = true;
            continue;
          }
          if (targetFound && cell) {
            var cellText = normalizeText(cell.textContent || '');
            if (cellText && !/^(yes|no|yes\s*\/\s*no)$/i.test(cellText) && cellText.length > 3) {
              return cellText;
            }
          }
        }

        // Legacy / ASP.NET pattern: the question label appears in the previous cell in the same row.
        var previousNeighbor = null;
        for (var j = 0; j < row.children.length; j++) {
          if (row.children[j].contains && row.children[j].contains(element)) {
            break;
          }
          previousNeighbor = row.children[j];
        }
        if (previousNeighbor) {
          var prevText = normalizeText(previousNeighbor.textContent || '');
          if (prevText && !/^(yes|no|yes\s*\/\s*no)$/i.test(prevText) && prevText.length > 3) {
            return prevText;
          }
        }
      }

      current = current.parentElement;
    }

    return inferLabel(element);
  }

  function getRadioGroupMembers(element) {
    if (!element || (element.type || '').toLowerCase() !== 'radio') return [];
    var doc = element.ownerDocument || document;
    var key = getGroupKey(element);
    if (!key) return [element];

    var group = [];
    var allRadios = doc.querySelectorAll('input[type="radio"]');
    for (var i = 0; i < allRadios.length; i++) {
      var radio = allRadios[i];
      if (getGroupKey(radio) === key) {
        group.push(radio);
      }
    }
    return group.length ? group : [element];
  }

  function shouldTrackElement(element) {
    if (!element) return false;
    var type = getElementType(element);
    if (isHiddenElement(element)) return false;
    if (type === 'submit' || type === 'button' || type === 'reset') return false;
    if (element.disabled) return false;
    return true;
  }

  function getInteractiveElements(rootNode) {
    var scope = rootNode || (typeof document !== 'undefined' ? document : null);
    if (!scope) return [];

    var elements = [];
    var candidates = scope.querySelectorAll('input, select, textarea');
    for (var i = 0; i < candidates.length; i++) {
      if (shouldTrackElement(candidates[i])) {
        elements.push(candidates[i]);
      }
    }
    return elements;
  }

  function captureCurrentFormState(rootNode) {
    var elements = getInteractiveElements(rootNode);
    var fields = [];
    var index = 0;
    var seenGroups = {};

    for (var i = 0; i < elements.length; i++) {
      var element = elements[i];
      var type = getElementType(element);

      if (type === 'radio') {
        var groupKey = getGroupKey(element);
        if (groupKey && seenGroups[groupKey]) {
          continue;
        }
        var groupMembers = getRadioGroupMembers(element);
        if (groupMembers.length > 1) {
          seenGroups[groupKey] = true;
          var options = [];
          var selectedValue = '';
          for (var j = 0; j < groupMembers.length; j++) {
            var optionValue = groupMembers[j].value || normalizeText(groupMembers[j].getAttribute('value') || '');
            if (!optionValue) {
              optionValue = normalizeText((groupMembers[j].nextSibling && groupMembers[j].nextSibling.textContent) || '');
            }
            if (optionValue) options.push(optionValue);
            if (groupMembers[j].checked) selectedValue = optionValue;
          }

          fields.push({
            domIndex: index,
            name: groupMembers[0].getAttribute('data-id') || groupMembers[0].getAttribute('name') || groupMembers[0].getAttribute('id') || '',
            type: 'radio',
            label: inferGroupLabel(groupMembers[0]),
            currentValue: selectedValue,
            options: options
          });
          index += 1;
          continue;
        }
      }

      fields.push({
        domIndex: index,
        name: element.getAttribute('name') || element.getAttribute('id') || '',
        type: type,
        label: inferLabel(element),
        currentValue: getCurrentValue(element),
        options: getSelectOptions(element)
      });

      index += 1;
    }

    return fields;
  }

  function resolveTargetElement(action) {
    var documentRef = typeof document !== 'undefined' ? document : null;
    if (!documentRef) return null;

    var byName = '';
    if (action && typeof action === 'object') {
      byName = action.name || action.targetName || action.field || action.target || action.identifier || '';
    }

    // 1) Prefer a name-based lookup, matching the contract of legacy forms.
    if (byName) {
      var exactMatch = documentRef.querySelector('[name="' + String(byName).replace(/"/g, '\\"') + '"]');
      if (exactMatch) return exactMatch;

      var dataIdMatch = documentRef.querySelector('[data-id="' + String(byName).replace(/"/g, '\\"') + '"]');
      if (dataIdMatch) return dataIdMatch;

      var idMatch = documentRef.querySelector('[id*="' + String(byName).replace(/"/g, '\\"') + '"]');
      if (idMatch) return idMatch;

      var namePrefixMatch = documentRef.querySelector('[name^="' + String(byName).replace(/"/g, '\\"') + '"]');
      if (namePrefixMatch) return namePrefixMatch;
    }

    // 2) Fall back to the domIndex if present.
    if (action && typeof action === 'object') {
      var domIndex = action.domIndex;
      if (domIndex === undefined || domIndex === null) {
        domIndex = action.index;
      }
      if (domIndex === undefined || domIndex === null) {
        domIndex = action.targetIndex;
      }
      if (domIndex !== undefined && domIndex !== null) {
        var elements = getInteractiveElements(documentRef);
        if (elements[Number(domIndex)]) return elements[Number(domIndex)];
      }
    }

    // 3) If the action carries an explicit selector, use it as the last fallback.
    if (action && typeof action === 'object') {
      var selector = action.selector || action.targetSelector || action.id;
      if (selector) {
        return documentRef.querySelector(selector);
      }
    }

    return null;
  }

  function setElementValue(element, rawValue) {
    if (!element) return false;

    var tagName = element.tagName ? element.tagName.toLowerCase() : '';
    var type = (element.type || '').toLowerCase();
    var valueString = rawValue == null ? '' : String(rawValue);

    if (type === 'radio') {
      var group = getRadioGroupMembers(element);
      var matched = false;
      for (var i = 0; i < group.length; i++) {
        var option = group[i];
        var optionValue = option.value || normalizeText(option.getAttribute('value') || '');
        var normalized = normalizeText(valueString).toLowerCase();
        var optionMatches = optionValue && optionValue.toLowerCase() === normalized;
        var labelMatches = normalizeText((option.parentElement && option.parentElement.textContent) || '').toLowerCase() === normalized;
        if (optionMatches || labelMatches || (normalized === 'yes' && optionValue.toLowerCase() === 'yes')) {
          option.checked = true;
          matched = true;
        } else if (group.length > 1) {
          option.checked = false;
        }
      }
      if (!matched && group.length > 1 && valueString) {
        for (var j = 0; j < group.length; j++) {
          if (group[j].value && group[j].value.toLowerCase() === valueString.toLowerCase()) {
            group[j].checked = true;
            matched = true;
            break;
          }
        }
      }
      if (!matched && group.length > 1) {
        group[0].checked = true;
      }
      group.forEach(function (radio) {
        radio.dispatchEvent(new Event('input', { bubbles: true }));
        radio.dispatchEvent(new Event('change', { bubbles: true }));
      });
    } else if (type === 'checkbox' || type === 'radio') {
      var shouldCheck = rawValue === true || rawValue === 'true' || rawValue === '1' || rawValue === 'yes' || rawValue === 'y' || rawValue === 'checked';
      element.checked = shouldCheck;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (tagName === 'select') {
      var matched = false;
      for (var k = 0; k < element.options.length; k++) {
        var option = element.options[k];
        if (option.value === valueString || normalizeText(option.textContent) === valueString || k === Number(valueString)) {
          element.selectedIndex = k;
          matched = true;
          break;
        }
      }
      if (!matched) {
        element.value = valueString;
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      element.value = valueString;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (typeof window !== 'undefined' && window.document) {
      try {
        persistCurrentFormState(element.ownerDocument);
      } catch (error) {
        // Ignore persistence failures.
      }
    }

    return true;
  }

  function applyAIBindings(actions) {
    if (!actions || !actions.length) return [];

    var applied = [];
    for (var i = 0; i < actions.length; i++) {
      var action = actions[i];
      if (!action || typeof action !== 'object') continue;

      var target = resolveTargetElement(action);
      if (!target) continue;

      var value = action.value;
      if (value === undefined) value = action.newValue;
      if (value === undefined) value = action.text;
      if (value === undefined) value = action.input;

      var wasApplied = setElementValue(target, value);
      if (wasApplied) {
        applied.push({
          target: action.name || action.target || action.field || action.identifier || '',
          domIndex: action.domIndex || action.index || action.targetIndex,
          value: value
        });
      }
    }

    return applied;
  }

  function createLauncher(doc, options) {
    if (!doc) return null;

    var existing = doc.getElementById('legacy-ai-binder-launcher');
    if (existing) return existing;

    var launcher = doc.createElement('button');
    launcher.id = 'legacy-ai-binder-launcher';
    launcher.type = 'button';
    launcher.textContent = 'AI Binder';
    launcher.style.cssText = [
      'position:fixed',
      'left:16px',
      'bottom:16px',
      'z-index:2147483647',
      'padding:10px 14px',
      'border:none',
      'border-radius:999px',
      'background:#2563eb',
      'color:#fff',
      'cursor:pointer',
      'box-shadow:0 8px 24px rgba(0,0,0,0.2)',
      'font-family:Arial, sans-serif',
      'font-size:13px'
    ].join(';');

    launcher.addEventListener('click', function () {
      createChatBox(options);
    });

    doc.body.appendChild(launcher);
    return launcher;
  }

  function createChatBox(options) {
    var doc = typeof document !== 'undefined' ? document : null;
    if (!doc || !doc.body) return null;

    var existing = doc.getElementById('legacy-ai-chatbox');
    if (existing) {
      existing.style.display = 'block';
      return existing;
    }

    var container = doc.createElement('div');
    container.id = 'legacy-ai-chatbox';
    container.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'width:320px',
      'max-width:calc(100vw - 24px)',
      'background:#111827',
      'color:#f9fafb',
      'border:1px solid #374151',
      'border-radius:12px',
      'box-shadow:0 10px 30px rgba(0,0,0,0.25)',
      'z-index:2147483647',
      'font-family:Arial, sans-serif',
      'overflow:hidden'
    ].join(';');

    var header = doc.createElement('div');
    header.style.cssText = 'padding:12px 14px;border-bottom:1px solid #374151;background:#1f2937;';
    header.innerHTML = '<strong>Legacy AI Binder</strong><div style="font-size:12px;color:#9ca3af">Injected onto this page</div>';

    var body = doc.createElement('div');
    body.style.cssText = 'padding:12px 14px;max-height:320px;overflow:auto;';

    var footer = doc.createElement('form');
    footer.style.cssText = 'display:flex;gap:8px;padding:12px 14px;border-top:1px solid #374151;';

    var input = doc.createElement('input');
    input.type = 'text';
    input.placeholder = 'Type a value and press Enter';
    input.style.cssText = 'flex:1;padding:8px 10px;border-radius:8px;border:1px solid #4b5563;background:#111827;color:#fff;';

    var button = doc.createElement('button');
    button.type = 'submit';
    button.textContent = 'Send';
    button.style.cssText = 'padding:8px 10px;border:none;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer;';

    footer.appendChild(input);
    footer.appendChild(button);
    container.appendChild(header);
    container.appendChild(body);
    container.appendChild(footer);
    doc.body.appendChild(container);

    var chatState = {
      fields: [],
      currentIndex: 0
    };

    var restoredState = readPersistedState();
    if (restoredState && restoredState.fields && restoredState.fields.length) {
      var restoredNotice = doc.createElement('div');
      restoredNotice.style.cssText = 'margin-bottom:8px;padding:8px 10px;border-radius:8px;background:#374151;font-size:13px;line-height:1.4;';
      restoredNotice.textContent = 'Restored previous values from memory.';
      body.appendChild(restoredNotice);
    }

    function renderMessage(text, role) {
      var bubble = doc.createElement('div');
      bubble.style.cssText = 'margin-bottom:8px;padding:8px 10px;border-radius:8px;background:' + (role === 'assistant' ? '#1f2937' : '#2563eb') + ';font-size:13px;line-height:1.4;';
      bubble.textContent = text;
      body.appendChild(bubble);
      body.scrollTop = body.scrollHeight;
    }

    function startConversation() {
      chatState.fields = captureCurrentFormState(doc);
      chatState.currentIndex = 0;
      body.innerHTML = '';

      var restoredState = readPersistedState();
      if (restoredState && restoredState.fields && restoredState.fields.length) {
        renderMessage('Restored previous values from memory.', 'assistant');
      }

      if (!chatState.fields.length) {
        renderMessage('No interactive form fields were found on this page.', 'assistant');
        return;
      }

      renderMessage('I will walk through each field and let you update it live.', 'assistant');
      askNextField();
    }

    function askNextField() {
      if (!chatState.fields.length || chatState.currentIndex >= chatState.fields.length) {
        renderMessage('Finished. The demo is complete.', 'assistant');
        input.placeholder = 'Type a value and press Enter';
        return;
      }

      var field = chatState.fields[chatState.currentIndex];
      var label = field.label || field.name || field.type || 'field';
      var currentValue = field.currentValue === '' || field.currentValue === undefined || field.currentValue === null ? '(empty)' : field.currentValue;
      renderMessage('Update ' + label + ' (current value: ' + currentValue + ')', 'assistant');
      input.value = '';
      input.focus();
    }

    footer.addEventListener('submit', function (event) {
      event.preventDefault();
      if (!chatState.fields.length) return;

      var field = chatState.fields[chatState.currentIndex];
      var value = normalizeText(input.value);
      if (!value) {
        renderMessage('No value entered. Skipping this field.', 'assistant');
      } else {
        var action = {
          name: field.name,
          domIndex: field.domIndex,
          value: value
        };
        applyAIBindings([action]);
        renderMessage('Updated ' + (field.label || field.name || field.type) + ' to: ' + value, 'assistant');
      }

      chatState.currentIndex += 1;
      askNextField();
    });

    var refreshButton = doc.createElement('button');
    refreshButton.textContent = 'Rescan';
    refreshButton.style.cssText = 'width:100%;padding:8px 10px;border:none;border-radius:8px;background:#374151;color:#fff;cursor:pointer;margin-top:8px;';
    refreshButton.addEventListener('click', function () {
      startConversation();
    });
    body.appendChild(refreshButton);

    startConversation();
    return container;
  }

  function inject(options) {
    if (typeof document === 'undefined') return null;
    createLauncher(document, options);
    var chatBox = createChatBox(options);
    restorePersistedValues(document);
    return chatBox;
  }

  function init() {
    if (typeof document === 'undefined') return;
    inject({ autoOpen: true });
    setTimeout(function () {
      restorePersistedValues(document);
    }, 150);
  }

  return {
    captureCurrentFormState: captureCurrentFormState,
    applyAIBindings: applyAIBindings,
    createChatBox: createChatBox,
    createLauncher: createLauncher,
    inject: inject,
    init: init
  };
});
