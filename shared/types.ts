// Data model shared by the browser, the server and the exporter.
// Everything here is plain JSON so a project can be saved, diffed and undone as a whole.
//
// Source media is never modified. A project only says which parts of which
// files play when, and what is drawn over them.

export type ID = string;

export interface AudioMaster {
  /** Bring the finished mix to `targetLufs` on export. */
  normalize: boolean;
  targetLufs: number;
  /** Light broadband noise reduction on speech. */
  denoise: boolean;
  /** Make speech clearer on export: cut rumble, add presence, even out the level. */
  enhance?: boolean;
}

export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  background: string;
  audio: AudioMaster;
}

/** Fields every timeline item carries. */
export interface ItemMeta {
  /** Human-readable label shown on the timeline ("Hook comment popup"). */
  name?: string;
  /** Id of the chat message that created the item. */
  createdBy?: string;
}

/** How a source frame is fitted into the output frame. */
export interface Framing {
  fit: 'cover' | 'contain';
  /** Point of the source that stays centred when cropping, 0..1. */
  focusX: number;
  focusY: number;
  /** Extra zoom applied on top of the fit (1 = none). */
  scale: number;
  /** Follow the detected face instead of the fixed focus point. */
  track?: boolean;
  /** With `contain`: fill the bars with a blurred copy of the picture. */
  blurFill?: boolean;
}

/** Colour adjustments; every value is a multiplier where 1 leaves the picture unchanged. */
export interface ClipFx {
  brightness?: number;
  contrast?: number;
  saturation?: number;
  /** 0..1, where 1 is fully black and white. */
  grayscale?: number;
  /** Blur radius as a fraction of the frame width. */
  blur?: number;
  /** -1 (cool blue) to 1 (warm orange). */
  warmth?: number;
  /** 0..1, darkening of the edges. */
  vignette?: number;
  /** 0..1, old-photo brown tint. */
  sepia?: number;
  /** 0..1, film grain over the picture. */
  grain?: number;
  /** Height of the black bars top and bottom, as a fraction of the frame height (0.12 is the usual cinema look). */
  letterbox?: number;
  /** Mirror the picture left to right. */
  flip?: boolean;
}

export type TransitionType = 'fade' | 'dip' | 'flash' | 'slide-left' | 'slide-right' | 'slide-up' | 'whip' | 'zoom' | 'blur' | 'glitch';

/** How a main clip arrives from the one before it. */
export interface Transition {
  type: TransitionType;
  duration: number;
}

/** A piece of a media file. `in`/`out` are seconds in the source. */
export interface SourceClip extends ItemMeta {
  id: ID;
  mediaId: ID;
  in: number;
  out: number;
  speed: number;
  /** Linear gain, 1 = unchanged. */
  volume: number;
  muted?: boolean;
  fadeIn?: number;
  fadeOut?: number;
  framing?: Framing;
  fx?: ClipFx;
}

export interface MediaMainClip extends SourceClip {
  kind: 'media';
  transition?: Transition;
}

/** A solid colour on the main track, used behind title cards. */
export interface ColorMainClip extends ItemMeta {
  kind: 'color';
  id: ID;
  duration: number;
  color: string;
  transition?: Transition;
}

/** The main track is magnetic: clips play back to back in array order. */
export type MainClip = MediaMainClip | ColorMainClip;

export type Ease = 'linear' | 'in' | 'out' | 'inout' | 'back';

export interface Transform {
  /** Centre of the element, 0..1 of the frame. */
  x: number;
  y: number;
  scale: number;
  /** Degrees, clockwise. */
  rotation: number;
  opacity: number;
}

/** Values an element should have `t` seconds after it starts. Unset properties are left alone. */
export interface Keyframe extends Partial<Transform> {
  t: number;
  ease?: Ease;
}

/** B-roll and other visuals drawn over the main track. */
export interface OverlayClip extends SourceClip {
  start: number;
  opacity?: number;
  /** Shrink or move the layer (picture-in-picture). Defaults to filling the frame. */
  transform?: Partial<Transform>;
  keyframes?: Keyframe[];
  /** Corner radius as a fraction of the layer width. */
  radius?: number;
}

export type AudioRole = 'voice' | 'music' | 'sfx';

export interface AudioClip extends SourceClip {
  start: number;
  role: AudioRole;
  /** Music only: lower the volume while someone is speaking. */
  duck?: boolean;
}

export type GraphicTemplate =
  | 'text'
  | 'popup'
  | 'comment'
  | 'headline'
  | 'lower-third'
  | 'callout'
  | 'counter'
  | 'list'
  | 'image'
  | 'highlight'
  | 'emoji'
  | 'progress';

export type AnimKind = 'none' | 'fade' | 'pop' | 'bounce' | 'zoom' | 'typewriter' | 'slide-up' | 'slide-down' | 'slide-left' | 'slide-right';

/**
 * Anything drawn on the Graphic track: plain text, pop-up cards, callouts.
 * `props` depends on the template (see shared/graphics.ts).
 */
export interface GraphicItem extends ItemMeta, Transform {
  id: ID;
  start: number;
  duration: number;
  template: GraphicTemplate;
  props: Record<string, unknown>;
  animIn: AnimKind;
  animOut: AnimKind;
  keyframes?: Keyframe[];
}

/** A punch-in on the main track. */
export interface ZoomItem extends ItemMeta {
  id: ID;
  start: number;
  duration: number;
  scale: number;
  /** When set, the zoom drifts from `scale` to this over its length (a slow push-in). */
  toScale?: number;
  /** Point of the frame the zoom closes in on, 0..1. */
  focusX: number;
  focusY: number;
  ease: 'cut' | 'smooth';
  /** 0..1: the picture shakes for the length of the item (a hit, a beat, a shock). */
  shake?: number;
}

export type CaptionStyle =
  | 'clean'
  | 'pop'
  | 'highlight'
  | 'boxed'
  | 'karaoke'
  | 'outline'
  | 'oneword'
  | 'glow'
  | 'glass'
  | 'typewriter'
  | 'band'
  | 'underline'
  | 'retro'
  | 'comic';

export interface CaptionSettings {
  enabled: boolean;
  style: CaptionStyle;
  /** Vertical centre of the caption block, 0..1 of the frame height. */
  y: number;
  /** Size multiplier, 1 = the style's default. */
  size: number;
  maxWords: number;
  uppercase: boolean;
  punctuation: boolean;
  color: string;
  accent: string;
  /** Overrides the style's font family. */
  font?: string;
  /** Corrections keyed by `${mediaId}:${wordIndex}`; an empty string hides the word. */
  edits: Record<string, string>;
  /** Keys of words that stay in the accent colour: numbers, names, the payoff. */
  emphasis?: string[];
}

/** Several recordings of the same line. Word ranges are inclusive indices into the media's transcript. */
export interface TakeGroup {
  id: ID;
  mediaId: ID;
  takes: { from: number; to: number }[];
  /** Index of the take that is kept, or null while undecided. */
  chosen: number | null;
  reason?: string;
}

export interface ProjectDoc {
  version: 2;
  id: ID;
  name: string;
  createdAt: number;
  updatedAt: number;
  settings: ProjectSettings;
  main: MainClip[];
  overlays: OverlayClip[];
  audio: AudioClip[];
  graphics: GraphicItem[];
  zooms: ZoomItem[];
  captions: CaptionSettings;
  takes: TakeGroup[];
}

// ---------------------------------------------------------------------------
// Media library

export type MediaKind = 'video' | 'audio' | 'image';
export type JobState = 'pending' | 'running' | 'done' | 'error' | 'skipped';

export interface MediaInsights {
  summary: string;
  tags: string[];
  at: number;
}

export interface MediaAsset {
  id: ID;
  name: string;
  kind: MediaKind;
  /** Absolute path of the original file. */
  path: string;
  /** True when the file was copied into the project folder and is deleted with it. */
  managed: boolean;
  size: number;
  duration: number;
  /** Display size, rotation already applied. */
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  hasVideo: boolean;
  codec?: string;
  hdr?: boolean;
  /** Degrees the stored picture is turned clockwise for display. */
  rotation?: number;
  hasAlpha?: boolean;
  addedAt: number;
  proxy: JobState;
  analysis: JobState;
  transcript: JobState;
  faces?: JobState;
  /** Progress of whichever step is running, 0..1. */
  progress?: number;
  stage?: string;
  error?: string;
  language?: string;
  wordCount?: number;
  /** Seconds of the audio in which a voice was detected. */
  speechSeconds?: number;
  /** Bumped when derived files change so the browser refetches them. */
  rev: number;
  /** Filmstrip sprite: `count` tiles of `tileW`×`tileH`, one every `interval` seconds. */
  strip?: { interval: number; tileW: number; tileH: number; count: number };
  /** Share of the audio that is above the noise floor, 0..1. */
  soundRatio?: number;
  /** Where the file came from when it was not added by the user. */
  origin?: 'sfx' | 'voiceover' | 'library' | 'gif' | 'meme';
  /** How many different voices were heard, when speaker labels are available. */
  speakers?: number;
  /** Short handle the chat agent uses for this file's words ("a", "b", ...). */
  tag?: string;
  insights?: MediaInsights;
}

/** A spoken word, in seconds of the source file. */
export interface Word {
  t0: number;
  t1: number;
  text: string;
  p?: number;
  /** Speaker number when more than one voice was found. */
  s?: number;
}

export interface Transcript {
  language: string;
  words: Word[];
}

/** Where the subject's face is over the length of a clip, sampled a few times a second. */
export interface FaceTrack {
  interval: number;
  /** One entry per sample: [centreX, centreY, width, height] in 0..1 of the frame, or null. */
  boxes: ([number, number, number, number] | null)[];
}

export interface Range {
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// Chat, history and export

export interface ChatAction {
  id: string;
  tool: string;
  label: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
}

export interface ChatMessage {
  id: ID;
  role: 'user' | 'assistant';
  text: string;
  ts: number;
  status?: 'running' | 'reviewing' | 'done' | 'error' | 'stopped';
  /** What the assistant did, in order. */
  actions?: ChatAction[];
  /** The assistant's own notes on why (shown collapsed). */
  reasoning?: string;
  /** Id of the project snapshot taken before this turn, for Undo. */
  snapshot?: string;
  reverted?: boolean;
  error?: string;
  /** Files attached to a user message. */
  attachments?: string[];
}

/** One entry of the append-only edit log. */
export interface HistoryEntry {
  id: ID;
  ts: number;
  by: 'agent' | 'user';
  messageId?: string;
  op: string;
  explain: string;
}

export interface Snapshot {
  id: ID;
  name: string;
  ts: number;
  auto?: boolean;
  duration: number;
}

export interface ExportJob {
  id: ID;
  projectId: ID;
  status: 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  stage: string;
  width: number;
  height: number;
  fps: number;
  path?: string;
  size?: number;
  duration?: number;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

// ---------------------------------------------------------------------------
// The planner: who the creator is, what is planned, what is known about the platforms

export interface Profile {
  /** The creator or brand in a sentence or two. */
  about: string;
  /** What the account is about: the subject, the angle. */
  niche: string;
  /** Who it is for. */
  audience: string;
  platforms: string[];
  /** What success looks like, in the creator's words. */
  goals: string;
  /** How much they can make: posts per week, time available. */
  capacity: string;
  /** Voice and style: tone, language, things to always or never do. */
  tone: string;
  pillars: string[];
  /** Anything else worth remembering. */
  notes: string;
  /** ISO codes of the languages spoken in the videos, e.g. ["hi", "en"]. Speech detection is limited to these; the first wins when detection is unsure. */
  languages: string[];
  /** Let the planner search the web for platform news. */
  allowWeb: boolean;
  updatedAt: number;
}

export type PlanStatus = 'idea' | 'planned' | 'making' | 'ready' | 'posted' | 'dropped';
export type PlanFormat = 'reel' | 'short' | 'story' | 'carousel' | 'post' | 'long';

export interface PlanItem {
  id: ID;
  /** YYYY-MM-DD; empty while it is only an idea. */
  date: string;
  /** HH:MM local, when a time is chosen. */
  time?: string;
  platform: string;
  format: PlanFormat;
  pillar?: string;
  title: string;
  hook: string;
  /** The story in a few lines: what happens, in what order, and the payoff. */
  storyline: string;
  /** Media ids in the footage library to make it from. */
  footage: ID[];
  caption?: string;
  hashtags?: string[];
  status: PlanStatus;
  /** The project this became, once it is being made. */
  projectId?: ID;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PlatformNote {
  text: string;
  sources: string[];
  updatedAt: number;
}

/** A post the creator likes, read into the shape that can be reused. */
export interface ReferenceCard {
  id: ID;
  /** Where it came from: a link, "pasted text", a screenshot's file name. */
  source: string;
  summary: string;
  hook: string;
  structure: string;
  pacing: string;
  text: string;
  sound: string;
  why: string;
  tags: string[];
  addedAt: number;
}

/** A saved editing style: how captions, text, colour, pacing and music should be done. */
export interface Recipe {
  id: ID;
  name: string;
  description: string;
  captions: Pick<CaptionSettings, 'style' | 'y' | 'size' | 'maxWords' | 'uppercase' | 'punctuation' | 'color' | 'accent'> & { font?: string };
  /** Font and style for hook and title text. */
  hookFont?: string;
  hookStyle?: string;
  look?: ClipFx;
  /** Pauses longer than this are cut, and how hard fillers are removed (0 to 2). */
  pacing: { silence: number; fillers: number };
  music: 'none' | 'quiet' | 'present';
  /** Anything else the editor should follow, in words. */
  notes: string;
  builtIn?: boolean;
}

/** App-wide settings, kept in data/studio/settings.json. */
export interface Settings {
  /** Claude model for both assistants: sonnet, opus or haiku. */
  assistantModel: 'sonnet' | 'opus' | 'haiku';
  /** Folder exports are written to; empty means ~/Documents/Local Studio. */
  exportDir: string;
  /** Tenor API key for GIF search; empty means GIF search is off. */
  tenorKey: string;
  /** Freesound API key for searching more sounds; empty means the search is off. */
  freesoundKey?: string;
  updatedAt: number;
}

export interface Studio {
  profile: Profile;
  plan: PlanItem[];
  notes: Record<string, PlatformNote>;
  references: ReferenceCard[];
}

export interface ProjectSummary {
  id: ID;
  name: string;
  updatedAt: number;
  createdAt: number;
  duration: number;
  width: number;
  height: number;
  thumb?: string;
}

export type SelectionKind = 'main' | 'overlay' | 'audio' | 'graphic' | 'zoom';

export type Selection = { kind: SelectionKind; id: ID } | { kind: 'caption'; id: string } | null;

export const ASPECTS: Record<string, { width: number; height: number; label: string }> = {
  '9:16': { width: 1080, height: 1920, label: 'Vertical' },
  '16:9': { width: 1920, height: 1080, label: 'Landscape' },
  '1:1': { width: 1080, height: 1080, label: 'Square' },
  '4:5': { width: 1080, height: 1350, label: 'Portrait' },
};

export function aspectOf(s: { width: number; height: number }): string {
  for (const [k, v] of Object.entries(ASPECTS)) if (v.width === s.width && v.height === s.height) return k;
  return `${s.width}×${s.height}`;
}
