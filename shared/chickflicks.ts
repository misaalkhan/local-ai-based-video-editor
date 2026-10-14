// The chick flick shelf: the films and shows everyone quotes, with their
// best-known lines, a GIF search for each, and the reaction searches that
// carry girlypop edits. The lines go on as quote cards or stickers; the
// pictures come from GIF search, since the films themselves belong to their
// studios.

export interface ChickFlick {
  id: string;
  title: string;
  year: number;
  emoji: string;
  /** What to type into GIF search for this one. */
  gif: string;
  quotes: string[];
}

export const CHICK_FLICKS: ChickFlick[] = [
  { id: 'mean-girls', title: 'Mean Girls', year: 2004, emoji: '💅', gif: 'mean girls', quotes: ['On Wednesdays we wear pink', 'She doesn’t even go here', 'That’s so fetch', 'Stop trying to make fetch happen', 'The limit does not exist', 'You can’t sit with us', 'Get in loser, we’re going shopping', 'Is butter a carb?', 'I’m not like a regular mom, I’m a cool mom', 'Why are you so obsessed with me?', 'Grool', 'Four for you, Glen Coco', 'It’s October 3rd', 'So you agree? You think you’re really pretty?', 'Whatever, I’m getting cheese fries', 'Her hair is full of secrets', 'I want my pink shirt back', 'Raise your hand if you have ever been personally victimized by Regina George'] },
  { id: 'clueless', title: 'Clueless', year: 1995, emoji: '💛', gif: 'clueless cher', quotes: ['Ugh, as if!', 'I’m totally buggin’', 'You’re a virgin who can’t drive', 'She’s a full-on Monet', 'Rollin’ with the homies', 'Whatever!', 'Do you prefer fashion victim or ensembly challenged?'] },
  { id: 'legally-blonde', title: 'Legally Blonde', year: 2001, emoji: '🎀', gif: 'legally blonde elle woods', quotes: ['What, like it’s hard?', 'Bend and snap!', 'Exercise gives you endorphins. Endorphins make you happy', 'Whoever said orange was the new pink was seriously disturbed', 'Happy people just don’t shoot their husbands', 'I’ll show you how valuable Elle Woods can be'] },
  { id: 'devil-wears-prada', title: 'The Devil Wears Prada', year: 2006, emoji: '👠', gif: 'devil wears prada miranda', quotes: ['That’s all.', 'Florals? For spring? Groundbreaking.', 'By all means, move at a glacial pace. You know how that thrills me', 'Gird your loins!', 'Everybody wants to be us', 'Details of your incompetence do not interest me', 'A million girls would kill for this job', 'I’m just one stomach flu away from my goal weight'] },
  { id: '13-going-on-30', title: '13 Going on 30', year: 2004, emoji: '🪩', gif: '13 going on 30', quotes: ['Thirty, flirty and thriving', 'I want to be thirty, flirty and thriving'] },
  { id: 'barbie', title: 'Barbie', year: 2023, emoji: '💖', gif: 'barbie movie margot robbie', quotes: ['Hi Barbie!', 'I’m Kenough', 'Do you guys ever think about dying?', 'It is the best day ever. So was yesterday, and so is tomorrow', 'Sublime!'] },
  { id: 'gossip-girl', title: 'Gossip Girl', year: 2007, emoji: '💋', gif: 'gossip girl blair waldorf', quotes: ['xoxo, Gossip Girl', 'You know you love me', 'I’m Chuck Bass', 'Spotted:', 'Three words, eight letters. Say it and I’m yours', 'Whoever said that money doesn’t buy happiness didn’t know where to shop'] },
  { id: 'sex-and-the-city', title: 'Sex and the City', year: 1998, emoji: '🍸', gif: 'sex and the city carrie', quotes: ['I couldn’t help but wonder…', 'Hello, lover', 'I like my money right where I can see it: hanging in my closet', 'I will never be the woman with the perfect hair'] },
  { id: 'princess-diaries', title: 'The Princess Diaries', year: 2001, emoji: '👑', gif: 'princess diaries mia', quotes: ['Shut up!', 'A queen is never late. Everyone else is simply early', 'Courage is not the absence of fear'] },
  { id: 'pretty-woman', title: 'Pretty Woman', year: 1990, emoji: '🛍️', gif: 'pretty woman big mistake', quotes: ['Big mistake. Big. Huge!', 'She rescues him right back'] },
  { id: '10-things', title: '10 Things I Hate About You', year: 1999, emoji: '📝', gif: '10 things i hate about you', quotes: ['But mostly I hate the way I don’t hate you', 'Can you ever just be whelmed?', 'I think you can in Europe', 'You don’t always have to be who they want you to be'] },
  { id: 'bring-it-on', title: 'Bring It On', year: 2000, emoji: '📣', gif: 'bring it on cheer', quotes: ['This is not a democracy, it’s a cheerocracy'] },
  { id: 'shes-the-man', title: 'She’s the Man', year: 2006, emoji: '⚽', gif: 'shes the man', quotes: ['Do you like… cheese?'] },
  { id: 'easy-a', title: 'Easy A', year: 2010, emoji: '🅰️', gif: 'easy a emma stone', quotes: ['Whatever happened to chivalry? Does it only exist in 80s movies?', 'People hear what they want to hear'] },
  { id: 'mamma-mia', title: 'Mamma Mia!', year: 2008, emoji: '🌊', gif: 'mamma mia', quotes: ['Typical, isn’t it? You wait twenty years for a dad and then three come along at once'] },
  { id: 'pitch-perfect', title: 'Pitch Perfect', year: 2012, emoji: '🎤', gif: 'pitch perfect fat amy', quotes: ['Aca-awkward', 'Aca-scuse me?', 'Crushed it', 'Horizontal running', 'You guys are gonna get pitch-slapped'] },
  { id: 'the-notebook', title: 'The Notebook', year: 2004, emoji: '🕊️', gif: 'the notebook rain kiss', quotes: ['If you’re a bird, I’m a bird', 'It wasn’t over. It still isn’t over!', 'I want all of you, forever, you and me, every day'] },
  { id: 'bridget-jones', title: 'Bridget Jones’s Diary', year: 2001, emoji: '📔', gif: 'bridget jones', quotes: ['I like you very much. Just as you are'] },
  { id: 'shopaholic', title: 'Confessions of a Shopaholic', year: 2009, emoji: '💳', gif: 'confessions of a shopaholic', quotes: ['When I shop, the world gets better', 'Cost and worth are very different things'] },
  { id: 'twilight', title: 'Twilight', year: 2008, emoji: '🧛', gif: 'twilight bella edward', quotes: ['Hold on tight, spider monkey', 'Bella, where the hell have you been, loca?', 'This is the skin of a killer, Bella'] },
  { id: 'jennifers-body', title: 'Jennifer’s Body', year: 2009, emoji: '🔥', gif: 'jennifers body megan fox', quotes: ['Hell is a teenage girl', 'I’m not killing people. I’m killing boys'] },
  { id: 'gilmore-girls', title: 'Gilmore Girls', year: 2000, emoji: '☕', gif: 'gilmore girls lorelai coffee', quotes: ['I need coffee in an IV', 'Oy with the poodles already', 'Copper boom!'] },
  { id: 'crazy-rich-asians', title: 'Crazy Rich Asians', year: 2018, emoji: '💎', gif: 'crazy rich asians', quotes: ['I’m not leaving because I’m scared, or because I think I’m not enough'] },
  { id: 'to-all-the-boys', title: 'To All the Boys I’ve Loved Before', year: 2018, emoji: '💌', gif: 'to all the boys lara jean', quotes: ['Are you going to break my heart, Covey?'] },
  { id: 'freaky-friday', title: 'Freaky Friday', year: 2003, emoji: '🔮', gif: 'freaky friday lindsay lohan', quotes: ['Make good choices!'] },
  { id: 'cinderella-story', title: 'A Cinderella Story', year: 2004, emoji: '👟', gif: 'a cinderella story hilary duff', quotes: ['Waiting for you is like waiting for rain in this drought. Useless and disappointing', 'Never let the fear of striking out keep you from playing the game'] },
  { id: 'parent-trap', title: 'The Parent Trap', year: 1998, emoji: '👯', gif: 'the parent trap', quotes: ['You want to know the difference between us? I have class and you don’t'] },
  { id: 'sweet-home-alabama', title: 'Sweet Home Alabama', year: 2002, emoji: '🌾', gif: 'sweet home alabama', quotes: ['What do you want to be married to me for, anyhow?', 'So I can kiss you anytime I want'] },
  { id: 'how-to-lose-a-guy', title: 'How to Lose a Guy in 10 Days', year: 2003, emoji: '🌿', gif: 'how to lose a guy in 10 days', quotes: ['You can’t lose something you never found', 'Our love fern! You let it die!', 'Princess Sophia', 'Frost yourself'] },
  { id: 'miss-congeniality', title: 'Miss Congeniality', year: 2000, emoji: '👸', gif: 'miss congeniality', quotes: ['April 25th. Because it’s not too hot, not too cold. All you need is a light jacket', 'World peace'] },
  { id: 'the-proposal', title: 'The Proposal', year: 2009, emoji: '💍', gif: 'the proposal sandra bullock', quotes: ['Marry me. Because I’d like to date you'] },
  { id: 'dirty-dancing', title: 'Dirty Dancing', year: 1987, emoji: '🍉', gif: 'dirty dancing lift', quotes: ['Nobody puts Baby in a corner', 'I carried a watermelon'] },
  { id: 'grease', title: 'Grease', year: 1978, emoji: '🚗', gif: 'grease sandy', quotes: ['Tell me about it, stud'] },
  { id: 'pretty-in-pink', title: 'Pretty in Pink', year: 1986, emoji: '🌸', gif: 'pretty in pink molly ringwald', quotes: ['I just want them to know that they didn’t break me'] },
  { id: 'heathers', title: 'Heathers', year: 1988, emoji: '🩸', gif: 'heathers winona', quotes: ['What’s your damage, Heather?', 'How very.'] },
  { id: 'romy-and-michele', title: 'Romy and Michele’s High School Reunion', year: 1997, emoji: '📎', gif: 'romy and michele', quotes: ['I invented Post-its', 'I’m the Mary, and you’re the Rhoda'] },
  { id: 'never-been-kissed', title: 'Never Been Kissed', year: 1999, emoji: '💄', gif: 'never been kissed', quotes: ['I’m not Josie Grossie anymore!'] },
  { id: 'bridesmaids', title: 'Bridesmaids', year: 2011, emoji: '👰', gif: 'bridesmaids help me im poor', quotes: ['Help me, I’m poor'] },
  { id: 'sisterhood', title: 'The Sisterhood of the Traveling Pants', year: 2005, emoji: '👖', gif: 'sisterhood of the traveling pants', quotes: ['Maybe the truth is, there’s a little bit of loser in all of us'] },
  { id: 'lizzie-mcguire', title: 'The Lizzie McGuire Movie', year: 2003, emoji: '🇮🇹', gif: 'lizzie mcguire movie', quotes: ['Sing to me, Paolo'] },
  { id: 'wild-child', title: 'Wild Child', year: 2008, emoji: '🏫', gif: 'wild child emma roberts', quotes: ['Harrods is my spiritual home'] },
  { id: 'white-chicks', title: 'White Chicks', year: 2004, emoji: '🛍️', gif: 'white chicks', quotes: ['Oh my God, a shopping threat!', 'I’m having a BF, a bitch fit'] },
  { id: 'john-tucker', title: 'John Tucker Must Die', year: 2006, emoji: '🏀', gif: 'john tucker must die', quotes: ['You can’t dump me. I dump you'] },
  { id: 'the-house-bunny', title: 'The House Bunny', year: 2008, emoji: '🐰', gif: 'house bunny anna faris', quotes: ['The eyes are the nipples of the face'] },
];

/** Reaction searches that carry girlypop edits, for the GIF chips. */
export const GIRLY_REACTIONS = ['hair flip', 'eye roll', 'slay', 'it’s giving', 'mother is mothering', 'delulu', 'girl dinner', 'hot girl walk', 'bestie', 'the ick', 'spill the tea', 'purse first', 'sassy', 'mean girls stare', 'princess', 'barbie wave', 'blowing a kiss', 'girls night', 'shopping spree', 'crying in the club'];

/** Every quote with its film, for search. */
export function allQuotes(): { film: ChickFlick; quote: string }[] {
  return CHICK_FLICKS.flatMap((film) => film.quotes.map((quote) => ({ film, quote })));
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

/** The quotes that best match some words (a film name, a few words of the line, or both), best first. */
export function findQuotes(query: string, limit = 8): { film: ChickFlick; quote: string; score: number }[] {
  const words = fold(query);
  if (!words.length) return [];
  const scored = allQuotes().map(({ film, quote }) => {
    const title = fold(film.title);
    const line = fold(quote);
    let score = 0;
    for (const w of words) {
      if (line.includes(w)) score += 2;
      else if (line.some((x) => x.startsWith(w))) score += 1;
      if (title.includes(w)) score += 1.5;
    }
    // Every word found in the line: a near-exact ask.
    if (words.every((w) => line.includes(w))) score += 3;
    return { film, quote, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.quote.length - b.quote.length)
    .slice(0, limit);
}
