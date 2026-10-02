import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { WordPieceTokenizer, normalizeText, preTokenize, type TokenizerConfig } from './wordpiece';

const base: Omit<TokenizerConfig, 'vocab'> = {
  unkToken: '[UNK]',
  continuingPrefix: '##',
  maxInputCharsPerWord: 100,
  lowercase: true,
  stripAccents: true,
  handleChineseChars: true,
};

/** Small hand-built vocabulary so tokenisation rules can be asserted exactly. */
const vocab = [
  '[UNK]', // 0
  'the', // 1
  'gradient', // 2
  'descent', // 3
  'learn', // 4
  '##ing', // 5
  '##s', // 6
  '.', // 7
  ',', // 8
  'a', // 9
  '中', // 10
];
const config: TokenizerConfig = { ...base, vocab };
const tokenizer = new WordPieceTokenizer(config);

describe('normalizeText', () => {
  it('lowercases when configured', () => {
    expect(normalizeText('The GRADIENT', config)).toBe('the gradient');
  });

  it('leaves case alone when not configured', () => {
    expect(normalizeText('The', { ...config, lowercase: false })).toBe('The');
  });

  it('strips accents', () => {
    expect(normalizeText('café naïve', config)).toBe('cafe naive');
  });

  it('collapses control characters and normalises whitespace', () => {
    expect(normalizeText('a\u0000b\tc\nd', config)).toBe('ab c d');
  });

  it('pads CJK characters so each becomes its own word', () => {
    expect(normalizeText('中文', config).trim()).toBe('中  文');
  });

  it('leaves CJK untouched when the option is off', () => {
    expect(normalizeText('中文', { ...config, handleChineseChars: false })).toBe('中文');
  });
});

describe('preTokenize', () => {
  it('splits on whitespace', () => {
    expect(preTokenize('one two  three')).toEqual(['one', 'two', 'three']);
  });

  it('peels punctuation into separate tokens', () => {
    expect(preTokenize('hello, world.')).toEqual(['hello', ',', 'world', '.']);
  });

  it('splits ASCII symbols, which BERT counts as punctuation', () => {
    // `$` (36) and `+` (43) fall inside BERT's ASCII punctuation ranges even
    // though Unicode classifies them as symbols, so they do split.
    expect(preTokenize('a+b $5')).toEqual(['a', '+', 'b', '$', '5']);
  });

  it('keeps non-ASCII symbols attached', () => {
    // × (U+00D7) and € (U+20AC) match neither the ASCII ranges nor \p{P}.
    expect(preTokenize('3×4 12€')).toEqual(['3×4', '12€']);
  });

  it('returns nothing for blank input', () => {
    expect(preTokenize('   ')).toEqual([]);
    expect(preTokenize('')).toEqual([]);
  });
});

describe('WordPieceTokenizer', () => {
  it('encodes a known word', () => {
    expect(tokenizer.encode('the')).toEqual([1]);
  });

  it('lowercases before lookup', () => {
    // The regression this guards: the vocabulary is lowercase-only, so without
    // normalisation "The" would become [UNK] and embed nothing meaningful.
    expect(tokenizer.encode('The')).toEqual([1]);
    expect(tokenizer.tokenize('THE')).toEqual(['the']);
  });

  it('splits into subwords with the continuation prefix', () => {
    expect(tokenizer.tokenize('learning')).toEqual(['learn', '##ing']);
    expect(tokenizer.tokenize('learns')).toEqual(['learn', '##s']);
  });

  it('emits punctuation as its own token', () => {
    expect(tokenizer.tokenize('the gradient.')).toEqual(['the', 'gradient', '.']);
  });

  it('falls back to a single [UNK] for an unmatchable word', () => {
    // Not a partial decomposition — a half-matched word would embed noise.
    expect(tokenizer.tokenize('zzzqqq')).toEqual(['[UNK]']);
  });

  it('treats an over-long word as unknown rather than looping', () => {
    expect(tokenizer.encode('a'.repeat(200))).toEqual([0]);
  });

  it('returns nothing for empty input', () => {
    expect(tokenizer.encode('')).toEqual([]);
    expect(tokenizer.encode('   ')).toEqual([]);
  });

  it('handles a full sentence', () => {
    expect(tokenizer.tokenize('The gradient descent, learning.')).toEqual([
      'the',
      'gradient',
      'descent',
      ',',
      'learn',
      '##ing',
      '.',
    ]);
  });

  it('refuses a vocabulary with no unknown token', () => {
    expect(() => new WordPieceTokenizer({ ...config, vocab: ['the'] })).toThrow(/unknown token/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Against the real model, when it has been fetched                            */
/* -------------------------------------------------------------------------- */

const REAL_VOCAB = path.join(process.cwd(), 'public', 'models', 'search', 'vocab.json');
const hasRealModel = fs.existsSync(REAL_VOCAB);

// Skipped on a fresh clone: the weights are a build input, fetched by
// `npm run fetch:model`, not committed.
describe.skipIf(!hasRealModel)('against potion-base-8M', () => {
  const real: TokenizerConfig = JSON.parse(fs.readFileSync(REAL_VOCAB, 'utf8'));
  const realTokenizer = new WordPieceTokenizer(real);

  it('loads a lowercase vocabulary', () => {
    expect(real.lowercase).toBe(true);
    expect(real.vocab).toContain('the');
    expect(real.vocab).not.toContain('The');
  });

  it('tokenises ordinary lecture prose with almost no unknowns', () => {
    const text =
      'In this lecture we will look at gradient descent, backpropagation, and how ' +
      'neural networks learn from data by minimising a loss function.';
    const tokens = realTokenizer.tokenize(text);
    const unknowns = tokens.filter(t => t === '[UNK]').length;

    expect(tokens.length).toBeGreaterThan(20);
    // A correct pipeline leaves essentially no unknowns on plain English.
    expect(unknowns).toBe(0);
  });

  it('keeps technical vocabulary out of [UNK] via subwords', () => {
    for (const word of ['backpropagation', 'tokenisation', 'hyperparameter']) {
      const tokens = realTokenizer.tokenize(word);
      expect(tokens).not.toEqual(['[UNK]']);
      expect(tokens.length).toBeGreaterThan(0);
    }
  });

  it('is case-insensitive end to end', () => {
    expect(realTokenizer.encode('Gradient Descent')).toEqual(
      realTokenizer.encode('gradient descent')
    );
  });
});
