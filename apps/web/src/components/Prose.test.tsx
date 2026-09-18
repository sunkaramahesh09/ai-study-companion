import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Prose } from './Prose.tsx';

const html = (text: string) => renderToStaticMarkup(<Prose text={text} />);

describe('Prose', () => {
  // The literal answer from the screenshot that started this: every line of it
  // was being shown with its asterisks and hyphens intact.
  const REAL_ANSWER = [
    "Hello! I'm happy to help you get a solid overview of large language models (LLMs) — all based on the material you provided.",
    '',
    '- **What an LLM is** – a neural network trained on massive text corpora to learn language patterns and predict the next token in a sequence [S1].',
    '- **Why they are "large"** – because of the high number of parameters, the volume of training data, and the compute used during training [S2].',
    '- **Tokens** – the basic text units (whole words, sub-words, punctuation, etc.) that the model processes after tokenization [S2].',
  ].join('\n');

  it('renders the answer that was showing raw asterisks', () => {
    const out = html(REAL_ANSWER);
    expect(out).not.toContain('**');
    expect(out).toContain('<strong>What an LLM is</strong>');
    expect(out).toContain('<strong>Tokens</strong>');
    // One list holding all three items, not one list per line.
    expect(out.match(/<ul>/g)).toHaveLength(1);
    expect(out.match(/<li>/g)).toHaveLength(3);
    // The intro stayed a paragraph.
    expect(out).toContain('<p>Hello!');
  });

  it('turns a citation marker into the same chip the source list uses', () => {
    const out = html('Attention weights other tokens [S3].');
    expect(out).toContain('class="cite-ref"');
    expect(out).toContain('>S3<');
    expect(out).not.toContain('[S3]');
  });

  it('keeps a numbered list numbered', () => {
    const out = html('1. First\n2. Second\n3. Third');
    expect(out.match(/<ol>/g)).toHaveLength(1);
    expect(out.match(/<li>/g)).toHaveLength(3);
  });

  it('joins a wrapped list item rather than starting a new one', () => {
    const out = html('- A point that runs on\n    and continues here\n- A second point');
    expect(out.match(/<li>/g)).toHaveLength(2);
    expect(out).toContain('A point that runs on and continues here');
  });

  it('renders inline code and italics', () => {
    const out = html('Use `npm run dev` and *note* the flag.');
    expect(out).toContain('<code>npm run dev</code>');
    expect(out).toContain('<em>note</em>');
  });

  it('keeps single newlines inside a paragraph as breaks', () => {
    const out = html('First line\nSecond line');
    expect(out.match(/<p>/g)).toHaveLength(1);
    expect(out).toContain('<br/>');
  });

  it('starts a new paragraph on a blank line', () => {
    const out = html('One.\n\nTwo.');
    expect(out.match(/<p>/g)).toHaveLength(2);
  });

  it('escapes HTML in the model output rather than rendering it', () => {
    // The answer is generated from an uploaded document, which is data. A
    // <script> in a PDF must never become a <script> on the page.
    const out = html('<script>alert(1)</script> and <b>not bold</b>');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('<b>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('does not render a link, even when the model writes one', () => {
    // Deliberate: the URL would come from an untrusted document.
    const out = html('See [the docs](https://evil.example.com) for more.');
    expect(out).not.toContain('<a ');
    expect(out).toContain('https://evil.example.com');
  });

  it('leaves plain text alone', () => {
    const out = html('Just a sentence.');
    expect(out).toBe('<div class="prose"><p>Just a sentence.</p></div>');
  });
});
