const MAX_ACTIVITY_LINES = 48;
const MAX_RENDERED_PROSE = 120_000;

export function isActivityLine(line = '') {
  return /^(?:thinking:|plan:|tool(?:\s|:)|repl\(|openTab\(|listBrowserTabs\(|readFile\(|writeFile\(|click\(|fill\(|navigate\(|browser(?:\s|:)|\[?step(?:\s|\]|:))/i.test(line.trim());
}

function trimBlankEdges(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
}

function limitProse(value) {
  if (value.length <= MAX_RENDERED_PROSE) return { prose: value, truncated: false };
  const tail = value.slice(-MAX_RENDERED_PROSE);
  const firstBreak = tail.indexOf('\n');
  return {
    prose: `*Earlier output was omitted to keep this conversation responsive.*\n\n${tail.slice(firstBreak >= 0 ? firstBreak + 1 : 0)}`,
    truncated: true,
  };
}

export function splitRunOutput(output = '') {
  const activity = [];
  const proseLines = [];
  let insideFence = false;

  for (const line of String(output).split(/\r?\n/)) {
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      insideFence = !insideFence;
      proseLines.push(line);
      continue;
    }

    if (!insideFence && /^created\s+new\s+session(?:\s|:|$)/i.test(trimmed)) continue;

    if (!insideFence && isActivityLine(trimmed)) {
      activity.push(trimmed);
    } else {
      proseLines.push(line);
    }
  }

  const limited = limitProse(trimBlankEdges(proseLines).join('\n'));
  return {
    activity: activity.slice(-MAX_ACTIVITY_LINES),
    prose: limited.prose,
    truncated: limited.truncated,
  };
}
