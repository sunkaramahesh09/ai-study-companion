import { Fragment, type ReactNode } from 'react';

/**
 * Renders the small slice of Markdown that the models actually emit.
 *
 * Generated answers arrive with `**bold**`, `- ` bullets and `` `code` ``
 * whatever the prompt asks for, and `.turn-body` was showing them verbatim —
 * a wall of asterisks (D-069). The fix is to render them, not to keep asking
 * the model to stop.
 *
 * Hand-written rather than a Markdown package, for two reasons:
 *
 * 1. **This text is untrusted.** It is generated from the learner's uploaded
 *    material, which the whole app treats as data and never as instructions.
 *    Everything here builds React elements — there is no `dangerouslySetInnerHTML`
 *    and no HTML string anywhere in the path, so there is nothing for a
 *    crafted PDF to inject. Links are deliberately NOT supported for the same
 *    reason: `[text](url)` in a model's output, sourced from a document we did
 *    not write, is not a link this app is going to render.
 * 2. It is ~80 lines for the constructs that appear, against a dependency and
 *    its bundle three days from a deadline.
 *
 * Unsupported syntax degrades to plain text, which is exactly what the UI did
 * before, so nothing gets worse for a construct not handled here.
 */

/** One capture group wrapping the alternation, so `split` keeps the delimiters. */
const INLINE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\n]+\*|\[S\d+\])/g;

function inline(text: string, key: string): ReactNode[] {
  return text
    .split(INLINE)
    .filter((part) => part !== '')
    .map((part, i) => {
      const k = `${key}-${i}`;
      if (/^\*\*[^*\n]+\*\*$/.test(part)) return <strong key={k}>{part.slice(2, -2)}</strong>;
      if (/^__[^_\n]+__$/.test(part)) return <strong key={k}>{part.slice(2, -2)}</strong>;
      if (/^`[^`\n]+`$/.test(part)) return <code key={k}>{part.slice(1, -1)}</code>;
      if (/^\*[^*\n]+\*$/.test(part)) return <em key={k}>{part.slice(1, -1)}</em>;
      // The Tutor's own citation markers, which the source list below the
      // message already explains. Shown as the same chip so the two read as
      // one thing rather than as stray brackets mid-sentence.
      if (/^\[S\d+\]$/.test(part)) return <span key={k} className="cite-ref">{part.slice(1, -1)}</span>;
      return <Fragment key={k}>{part}</Fragment>;
    });
}

/** Single newlines inside a paragraph are kept as breaks — models mean them. */
function lines(block: string[], key: string): ReactNode[] {
  return block.flatMap((line, i) => [
    ...(i > 0 ? [<br key={`${key}-br-${i}`} />] : []),
    ...inline(line, `${key}-${i}`),
  ]);
}

const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const HEADING = /^#{1,6}\s+/;

export function Prose({ text }: { text: string }) {
  const rows = text.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length === 0) return;
    out.push(<p key={`p-${out.length}`}>{lines(paragraph, `p-${out.length}`)}</p>);
    paragraph = [];
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;

    if (row.trim() === '') {
      flush();
      continue;
    }

    if (HEADING.test(row)) {
      flush();
      out.push(<p key={`h-${out.length}`} className="prose-heading">{inline(row.replace(HEADING, ''), `h-${out.length}`)}</p>);
      continue;
    }

    const ordered = NUMBERED.test(row);
    if (ordered || BULLET.test(row)) {
      flush();
      // Consume the whole run of items, so a list is one element rather than
      // one list per line.
      const items: string[] = [];
      while (i < rows.length) {
        const r = rows[i]!;
        const isItem = ordered ? NUMBERED.test(r) : BULLET.test(r);
        if (!isItem) {
          // A line that is not a new item but is indented continues the last
          // one — models wrap long items.
          if (items.length > 0 && r.trim() !== '' && /^\s+\S/.test(r)) {
            items[items.length - 1] += ` ${r.trim()}`;
            i++;
            continue;
          }
          break;
        }
        items.push(r.replace(ordered ? NUMBERED : BULLET, ''));
        i++;
      }
      i--;
      const key = `l-${out.length}`;
      const children = items.map((item, n) => <li key={`${key}-${n}`}>{inline(item, `${key}-${n}`)}</li>);
      out.push(ordered ? <ol key={key}>{children}</ol> : <ul key={key}>{children}</ul>);
      continue;
    }

    paragraph.push(row);
  }
  flush();

  return <div className="prose">{out}</div>;
}
