import { test } from 'node:test';
import assert from 'node:assert/strict';
import { romanizeDevanagari, hasDevanagari } from '../shared/romanize.ts';

test('common words use their usual Hinglish spelling', () => {
  assert.equal(romanizeDevanagari('हम चले साइकल पे इटली की गलियों में।'), 'hum chale cycle pe Italy ki galiyon mein.');
  assert.equal(romanizeDevanagari('क्या हुआ? कुछ नहीं, अच्छा है।'), 'kya hua? kuch nahi, accha hai.');
});

test('other words are spelt by rule with silent vowels dropped', () => {
  assert.equal(romanizeDevanagari('लड़की कमरा समझ चलते सरकार उसकी अलग'), 'ladki kamra samajh chalte sarkar uski alag');
  assert.equal(romanizeDevanagari('संभव हिंदी अंग्रेज़ी ज़रूर'), 'sambhav hindi angrezi zarur');
  assert.equal(romanizeDevanagari('क'), 'ka');
});

test('Latin words, digits and punctuation pass through', () => {
  assert.equal(romanizeDevanagari("Let's go! रात में १० बजे।"), "Let's go! raat mein 10 baje.");
  assert.equal(romanizeDevanagari('plain English'), 'plain English');
  assert.equal(hasDevanagari('abc'), false);
  assert.equal(hasDevanagari('अब'), true);
});
