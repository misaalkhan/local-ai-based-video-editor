import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLink, findLinks, keepLinks, unescapeHtml } from '../shared/links.ts';
import { htmlToText, pagePictures, parseTimedText } from '../server/links.ts';

test('links are told apart: Reddit threads and subreddits, YouTube videos in every shape, Google Docs, pages', () => {
  assert.deepEqual(classifyLink('https://www.reddit.com/r/netflix/comments/1vgn22p/lets_marry_harry_initial_thoughts/'), { kind: 'reddit', url: 'https://www.reddit.com/r/netflix/comments/1vgn22p/lets_marry_harry_initial_thoughts/', id: '1vgn22p' });
  assert.equal(classifyLink('https://redd.it/1vgn22p').id, '1vgn22p');
  assert.equal(classifyLink('old.reddit.com/r/television/').kind, 'subreddit');
  assert.equal(classifyLink('https://www.reddit.com/r/netflix/s/AbCdEf123').kind, 'reddit');
  for (const u of ['https://www.youtube.com/watch?v=8S0FDjFBj8o&t=12s', 'https://youtu.be/8S0FDjFBj8o?si=xyz', 'https://youtube.com/shorts/8S0FDjFBj8o', 'https://m.youtube.com/watch?v=8S0FDjFBj8o']) {
    const c = classifyLink(u);
    assert.equal(c.kind, 'youtube', u);
    assert.equal(c.id, '8S0FDjFBj8o', u);
  }
  assert.equal(classifyLink('https://www.youtube.com/@TEDx').kind, 'page');
  assert.equal(classifyLink('https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit?usp=sharing').kind, 'gdoc');
  assert.equal(classifyLink('https://www.tvinsider.com/some/article').kind, 'page');
  assert.throws(() => classifyLink('not a link at all'), /not a web address/);
  assert.throws(() => classifyLink('ftp://x.y/z'), /Only http and https/);
});

test('a paste from a document keeps the addresses its links carried, in order, once each', () => {
  const html = '<p>Sources</p><ul><li><a href="https://a.example/one">Netflix Tudum — reunion recap</a></li><li><a href="https://b.example/two">TV Insider — every elimination</a></li><li><a href="https://www.google.com/url?q=https://c.example/three&amp;sa=D">here</a> and <a href="https://d.example/four">here</a></li></ul>';
  const plain = 'Sources\nNetflix Tudum — reunion recap\nTV Insider — every elimination\nhere and here';
  assert.equal(keepLinks(html, plain), 'Sources\nNetflix Tudum — reunion recap (https://a.example/one)\nTV Insider — every elimination (https://b.example/two)\nhere (https://c.example/three) and here (https://d.example/four)');
  // Nothing to add: the link text is the address already, or the plain text has it.
  assert.equal(keepLinks('<a href="https://a.example/">https://a.example/</a>', 'https://a.example/'), null);
  assert.equal(keepLinks('<a href="https://a.example/">site</a>', 'site https://a.example/'), null);
  assert.equal(keepLinks('', 'plain only'), null);
  assert.deepEqual(findLinks('see https://a.example/x, and (https://b.example/y) then https://a.example/x.'), ['https://a.example/x', 'https://b.example/y']);
  assert.equal(unescapeHtml('Tom &amp; Jerry &#8212; &quot;hi&quot; &#x1F600;'), 'Tom & Jerry — "hi" 😀');
});

test('YouTube timed text becomes timestamped lines', () => {
  const xml = '<?xml version="1.0"?><timedtext format="3"><body><p t="0" d="2000">Hello &amp; welcome</p><p t="61500" d="1000"><s>two</s> <s>words</s></p><p t="90000" d="10"></p></body></timedtext>';
  assert.deepEqual(parseTimedText(xml), ['[0:00] Hello & welcome', '[1:01] two words']);
});

test('a page gives its title, summary, article text and the pictures worth taking', () => {
  const html = `<html><head><title>Harry responds &amp; more</title><meta name="description" content="What he said."><meta property="og:image" content="/img/lead.jpg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="800">
  <script type="application/ld+json">{"@type":"NewsArticle","articleBody":"First paragraph of the article.\\nSecond paragraph, longer than the layout scrape would be because the layout is short."}</script></head>
  <body><nav><a href="/">Home</a></nav><header>Site header</header>
  <article><h1>Harry responds</h1><p>First paragraph of the article.</p><img src="/img/logo.png" width="300" height="100"><img data-src="//cdn.example.com/photo.jpg?w=1600" alt="Harry at the reunion" width="1600" height="900"><img src="/img/tiny.gif" width="16" height="16">
  <picture><img srcset="/img/small.jpg 400w, /img/big.jpg 1400w" alt="The cast"></picture><a href="/gallery/full-size.jpg">Full size</a></article>
  <footer>Footer text</footer></body></html>`;
  const t = htmlToText(html);
  assert.equal(t.title, 'Harry responds & more');
  assert.equal(t.description, 'What he said.');
  assert.match(t.body, /Second paragraph, longer/);
  assert.doesNotMatch(t.body, /Footer text|Site header/);
  const pics = pagePictures(html, 'https://news.example/story');
  assert.deepEqual(pics.map((p) => p.url), ['https://news.example/img/lead.jpg', 'https://cdn.example.com/photo.jpg?w=1600', 'https://news.example/img/big.jpg', 'https://news.example/gallery/full-size.jpg']);
  assert.equal(pics[1].alt, 'Harry at the reunion');
  assert.equal(pics[0].where, 'lead image');
  // Wikipedia thumbnails are swapped for the full picture.
  const wiki = '<main><img src="//thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Some_Photo.jpg/250px-Some_Photo.jpg?x=1" width="250" height="330" alt="Someone"></main>';
  assert.deepEqual(pagePictures(wiki, 'https://en.wikipedia.org/wiki/X').map((p) => p.url), ['https://upload.wikimedia.org/wikipedia/commons/a/ab/Some_Photo.jpg']);
});
