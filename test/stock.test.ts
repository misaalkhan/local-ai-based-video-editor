import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptable, archiveLicence, creditFor, STOCK_SOURCES } from '../server/stock.ts';
import { describeThreads } from '../server/reddit.ts';

test('only licences that allow use in a video are accepted, and credit is owed only for attribution licences', () => {
  for (const ok of ['CC0', 'Public domain', 'CC BY 4.0', 'CC BY-SA 3.0', 'Pexels', 'Pixabay', 'Public domain (NASA)']) assert.ok(acceptable(ok), ok);
  for (const no of ['CC BY-NC 4.0', 'CC BY-ND 2.0', 'CC BY-NC-SA 3.0', 'GFDL 1.2', 'All rights reserved', 'Fair use', '']) assert.ok(!acceptable(no), no);
  assert.equal(creditFor('CC0', 'Ann', 'Sunset', 'https://x'), '');
  assert.equal(creditFor('Pexels', 'Ann', 'Sunset', 'https://x'), '');
  assert.equal(creditFor('CC BY-SA 4.0', 'Ann', 'Sunset', 'https://x'), '"Sunset" by Ann, CC BY-SA 4.0, https://x');
  assert.equal(creditFor('CC BY 2.0', undefined, 'Sunset', 'https://x'), '"Sunset" by unknown, CC BY 2.0, https://x');
});

test('Internet Archive licence urls are read into short names', () => {
  assert.equal(archiveLicence('http://creativecommons.org/publicdomain/zero/1.0/'), 'CC0');
  assert.equal(archiveLicence('http://creativecommons.org/licenses/publicdomain/'), 'Public domain');
  assert.equal(archiveLicence('http://creativecommons.org/publicdomain/mark/1.0/'), 'Public domain');
  assert.equal(archiveLicence('https://creativecommons.org/licenses/by/3.0/'), 'CC BY 3.0');
  assert.equal(archiveLicence('https://creativecommons.org/licenses/by-nc/4.0/'), 'CC BY-NC 4.0');
  assert.ok(!acceptable(archiveLicence('https://creativecommons.org/licenses/by-nc/4.0/')));
  assert.equal(archiveLicence(undefined), '');
  assert.equal(STOCK_SOURCES.filter((s) => !s.key).length, 4);
});

test('a Reddit digest keeps scores, dates and short excerpts', () => {
  const text = describeThreads([
    { id: 'a', title: 'The finale', subreddit: 'tv', score: 1200, comments: 300, date: '2025-09-20', url: 'https://www.reddit.com/comments/a', text: 'Post body', top: [{ score: 90, text: 'Top take' }] },
  ]);
  assert.match(text, /r\/tv · 2025-09-20 · 1200 points · 300 comments/);
  assert.match(text, /Post: Post body/);
  assert.match(text, /- \(90\) Top take/);
  assert.match(describeThreads([]), /No threads found/);
});
