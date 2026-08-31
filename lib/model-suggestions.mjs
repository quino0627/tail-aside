const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function parseModelSuggestions(helpText = '', configuredDefault = '') {
  const suggestions = [];

  function add(value) {
    const model = String(value || '').trim();
    if (!MODEL_ID.test(model) || suggestions.includes(model)) return;
    suggestions.push(model);
  }

  add(configuredDefault);
  for (const line of String(helpText).split(/\r?\n/)) {
    const modelMatch = line.match(/(?:^|\s)(?:-m|--model)\s+([A-Za-z0-9][A-Za-z0-9._/-]{0,127})(?:\s|$)/);
    if (!modelMatch) continue;
    const providerMatch = line.match(/(?:^|\s)(?:-p|--provider)\s+([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:\s|$)/);
    const model = modelMatch[1];
    const provider = providerMatch?.[1];
    add(!model.includes('/') && PROVIDER_ID.test(provider || '') ? `${provider}/${model}` : model);
    if (suggestions.length >= 8) break;
  }

  return suggestions;
}
