import { z } from "zod";

export const PROTOCOL_VERSION = 1;

export const PiiKind = z.enum([
  "email",
  "phone",
  "card",
  "cvv",
  "password",
  "ssn",
  "aadhaar",
  "iban",
  "person_name",
  "address",
  "dob",
  "api_key",
  "other",
]);
export type PiiKind = z.infer<typeof PiiKind>;

export const Rect = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});
export type Rect = z.infer<typeof Rect>;

export const ValueSlot = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("redacted"),
    ref: z.string().regex(/^\[[A-Z_]+\d+\]$/),
    pii: PiiKind,
  }),
  z.object({
    kind: z.literal("text"),
    text: z.string().max(120),
  }),
]);
export type ValueSlot = z.infer<typeof ValueSlot>;

const SAFE_ATTR_KEYS = ["type", "autocomplete", "required", "checked", "selected"] as const;

export const ElementNode = z.object({
  id: z.number().int().nonnegative(),
  role: z.string(),
  tag: z.string().toLowerCase(),
  name: z.string().max(200).nullable(),
  value: ValueSlot.nullable(),
  editable: z.boolean(),
  rect: Rect,
  in_viewport: z.boolean(),
  attributes: z.record(z.enum(SAFE_ATTR_KEYS), z.string()).default({}),
});
export type ElementNode = z.infer<typeof ElementNode>;

export const PiiRef = z.object({
  ref: z.string(),
  kind: PiiKind,
});
export type PiiRef = z.infer<typeof PiiRef>;

export const ImageRegion = z.object({
  ref: z.string(),
  mime: z.literal("image/webp"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  data_b64: z.string(),
});
export type ImageRegion = z.infer<typeof ImageRegion>;

export const ScreenContext = z.object({
  url_skeleton: z.string().max(300),
  title: z.string().max(160),
  viewport: z.object({ w: z.number().int().positive(), h: z.number().int().positive() }),
  scroll: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  frame_hash: z.string(),
  elements: z.array(ElementNode).max(400),
  pii_refs: z.array(PiiRef).max(200).default([]),
  redaction_count: z.number().int().nonnegative(),
  image_regions: z.array(ImageRegion).max(8).default([]),
});
export type ScreenContext = z.infer<typeof ScreenContext>;

export const AgentAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), target: z.number().int().nonnegative() }),
  z.object({
    type: z.literal("fill"),
    target: z.number().int().nonnegative(),
    ref: z.string().optional(),
    text: z.string().max(300).optional(),
  }),
  z.object({
    type: z.literal("scroll"),
    direction: z.enum(["up", "down"]),
    amount: z.number().int().positive().max(5000).default(600),
  }),
  z.object({ type: z.literal("navigate"), url: z.string().refine((u) => /^https?:\/\//i.test(u)) }),
  z.object({ type: z.literal("wait"), ms: z.number().int().min(50).max(10000) }),
  z.object({ type: z.literal("done"), summary: z.string().max(500) }),
  z.object({ type: z.literal("fail"), reason: z.string().max(500) }),
]);
export type AgentAction = z.infer<typeof AgentAction>;

export const Timings = z.object({
  extract_ms: z.number().nonnegative(),
  redact_ms: z.number().nonnegative(),
  serialize_ms: z.number().nonnegative(),
  rtt_ms: z.number().nullable().default(null),
});
export type Timings = z.infer<typeof Timings>;

export const ClientHello = z.object({
  type: z.literal("hello"),
  v: z.literal(PROTOCOL_VERSION),
  session: z.string().min(8),
  caps: z.object({
    webgpu: z.boolean(),
    dpr: z.number().positive(),
  }),
});

export const PerceptionMsg = z.object({
  type: z.literal("perception"),
  seq: z.number().int().positive(),
  task: z.string().max(500),
  screen: ScreenContext,
  timings: Timings,
});

export const ActionResultMsg = z.object({
  type: z.literal("action_result"),
  seq: z.number().int().positive(),
  results: z
    .array(
      z.object({
        ok: z.boolean(),
        action_index: z.number().int().nonnegative(),
        error: z.string().max(300).optional(),
      })
    )
    .max(20),
});

export const ClientMessage = z.discriminatedUnion("type", [
  ClientHello,
  PerceptionMsg,
  ActionResultMsg,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const WelcomeMsg = z.object({
  type: z.literal("welcome"),
  session: z.string(),
  provider: z.string(),
  model: z.string(),
});

export const PlanMsg = z.object({
  type: z.literal("plan"),
  seq: z.number().int().positive(),
  thought: z.string().max(2000),
  actions: z.array(AgentAction).max(10),
  model: z.string(),
  usage_ms: z.number().nonnegative().optional(),
});

export const ServerErrorMsg = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string().max(500),
});

export const ServerMessage = z.discriminatedUnion("type", [
  WelcomeMsg,
  PlanMsg,
  ServerErrorMsg,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
export type WelcomeMsg = z.infer<typeof WelcomeMsg>;
export type PlanMsg = z.infer<typeof PlanMsg>;
export type ServerErrorMsg = z.infer<typeof ServerErrorMsg>;
