// These functions run inside the capture page. Preserve each element's actual
// visibility instead of competing with arbitrary recipe selector specificity.
export function resetIsolation() {
  for (const { element, value, priority } of window.__assetIsolation ?? []) {
    if (value) element.style.setProperty('visibility', value, priority);
    else element.style.removeProperty('visibility');
  }
  window.__assetIsolation = [];
}

export function isolateLayer(config) {
  if (config === null) return;
  const root = document.getElementById('export-root');
  const selector = typeof config === 'string' ? config : config.selector;
  const selected = Array.from(root.querySelectorAll(selector));
  if (!selected.length) throw Error(`layer selector missing: ${selector}`);
  const excluded = (typeof config === 'object' ? config.exclude ?? [] : []).flatMap(s => Array.from(root.querySelectorAll(s)));
  const records = Array.from(root.querySelectorAll('*')).map(element => ({
    element,
    value: element.style.getPropertyValue('visibility'),
    priority: element.style.getPropertyPriority('visibility'),
    visible: getComputedStyle(element).visibility === 'visible',
    included: selected.some(parent => parent === element || parent.contains(element)) && !excluded.some(parent => parent === element || parent.contains(element)),
  }));
  window.__assetIsolation = records;
  for (const { element, visible, included } of records) element.style.setProperty('visibility', visible && included ? 'visible' : 'hidden', 'important');
}
