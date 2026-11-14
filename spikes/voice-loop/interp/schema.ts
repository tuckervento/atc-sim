/**
 * The JSON schema the interpreter must answer in, shared by both providers (Anthropic
 * `output_config.format`, OpenAI `text.format` with `strict: true`).
 *
 * It mirrors `src/sim/commands.ts` (the `Transmission` type): same field names, same
 * nesting, every field required, `null` for "not given". Two provider limits shaped it:
 * - OpenAI strict mode: the root must be an object (not anyOf), every property must be in
 *   `required`, and `additionalProperties: false` everywhere. OpenAI doesn't list `const`,
 *   so discriminators are one-value `enum`s.
 * - Anthropic: at most 16 parameters with union types (anyOf or type arrays) across all
 *   strict schemas in a request. A literal mirror (Destination and HoldShortTarget as
 *   anyOf unions, turn as a type array) would be around 20.
 *   So two unions are flattened to `{kind, name}` objects, which give the same JSON:
 *   - Destination: `name` is string-or-null for every kind. commands.ts requires a name for
 *     a runway; `interp/shape.ts` enforces that after the model answers.
 *   - HoldShortTarget: `kind` is an enum, `name` a string. That's exact.
 *   - `turn` is an enum that includes null, with no `type`, so it isn't a union parameter.
 *
 * Everything the schema can't say (name and runway formats, non-empty lists, the
 * correction rules) is checked by `interp/shape.ts`. Invalid output counts as a miss.
 */

type Json = Record<string, unknown>;

const str = (description?: string): Json => (description ? { type: "string", description } : { type: "string" });
const nullableStr = (description: string): Json => ({ type: ["string", "null"], description });
const tag = (value: string): Json => ({ type: "string", enum: [value] });

function obj(properties: Record<string, Json>, description?: string): Json {
  const o: Json = { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
  if (description) o.description = description;
  return o;
}

const RUNWAY_DESC = "FAA style, no leading zero: '31L', '4R', '13'";
const NAME_DESC = "Airport ID, uppercase: 'A', 'KE', 'T4'";

export interface SchemaOptions {
  /** Put shared sub-schemas (route item, hold-short target, destination, crossing) in $defs. */
  refs: boolean;
  /** How the correction's nullable parts are written: anyOf [X, null], or type arrays. */
  nullable: "anyOf" | "typeArray";
}

export function buildSchema(opts: SchemaOptions): Json {
  const defs: Record<string, Json> = {};
  const share = (key: string, schema: Json): Json => {
    if (!opts.refs) return schema;
    defs[key] = schema;
    return { $ref: `#/$defs/${key}` };
  };
  /** X or null. A type array only works for a plain (non-$ref) object or array schema. */
  const orNull = (schema: Json, inline: Json): Json => {
    if (opts.nullable === "typeArray") return { ...inline, type: [inline.type as string, "null"] };
    return { anyOf: [schema, { type: "null" }] };
  };

  const turn: Json = { enum: ["left", "right", null], description: "Turn onto this taxiway, only when the controller said one" };
  const routeItemInline = obj({ taxiway: str(NAME_DESC), turn });
  const routeItem = share("routeItem", routeItemInline);
  const routeInline: Json = { type: "array", items: routeItem, description: "Taxiways in the order taxied" };
  const targetInline = obj({
    kind: { type: "string", enum: ["taxiway", "runway"] },
    name: str("Taxiway ID or runway"),
  });
  const target = share("holdShortTarget", targetInline);
  const holdShortListInline: Json = { type: "array", items: target };
  const destinationInline = obj({
    kind: { type: "string", enum: ["runway", "ramp", "pad", "penalty-box"] },
    name: nullableStr("Runway for kind runway; terminal ramp ID ('T4') or null for ramp; null for pad and penalty-box unless named"),
  });
  const destination = share("destination", destinationInline);
  const crossPartInline = obj({ runways: { type: "array", items: str(RUNWAY_DESC) }, at: nullableStr("Taxiway where it crosses, or null") });

  const taxi = obj({ type: tag("taxi"), to: destination, via: routeInline, holdShort: holdShortListInline });
  const holdShort = obj({ type: tag("hold-short"), target });
  const holdPosition = obj({ type: tag("hold-position") });
  const cont = obj({ type: tag("continue") });
  const cross = obj({
    type: tag("cross"),
    runways: { type: "array", items: str(RUNWAY_DESC) },
    at: nullableStr("Taxiway where it crosses, or null"),
  });
  const handoff = obj({
    type: tag("handoff"),
    mode: { type: "string", enum: ["monitor", "contact"] },
    facility: { type: "string", enum: ["tower", "ramp"] },
    frequency: nullableStr("MHz as written, trailing zeros dropped: '119.1'; null if not given"),
  });
  const correction = obj({
    type: tag("correction"),
    to: orNull(destination, destinationInline),
    via: orNull(routeInline, routeInline),
    turns: { type: "array", items: obj({ taxiway: str(NAME_DESC), turn: { type: "string", enum: ["left", "right"] } }) },
    holdShort: orNull(holdShortListInline, holdShortListInline),
    cross: orNull(crossPartInline, crossPartInline),
  });
  const atis = obj({
    type: tag("atis"),
    letter: str("One letter A-Z"),
    altimeter: nullableStr("Four digits: '2992'; null if not given"),
  });
  const sayAgain = obj({ type: tag("say-again") });
  const groundStop = obj({ type: tag("ground-stop"), destination: str("Destination airport code: 'ATL'") });
  const releaseTime = obj({ type: tag("release-time"), time: str("24-hour 'HH:MM'") });
  const holdForRelease = obj({ type: tag("hold-for-release") });
  const expectDelay = obj({ type: tag("expect-delay"), minutes: { type: "integer", description: "Whole minutes" } });

  const root = obj({
    type: tag("transmission"),
    callsign: nullableStr("ICAO flight ID without 'heavy': 'DAL4', 'UAE202'; null only for an unknown station"),
    instructions: {
      type: "array",
      description: "In spoken order. At least one.",
      items: {
        anyOf: [taxi, holdShort, holdPosition, cont, cross, handoff, correction, atis, sayAgain, groundStop, releaseTime, holdForRelease, expectDelay],
      },
    },
  });
  if (opts.refs) root.$defs = defs;
  return root;
}

export const TRANSMISSION_SCHEMA: Json = buildSchema({ refs: false, nullable: "anyOf" });

/** Counts parameters that use anyOf or a type array, as Anthropic's limit does (16). */
export function countUnionParams(schema: unknown): number {
  if (Array.isArray(schema)) return schema.reduce((n: number, s) => n + countUnionParams(s), 0);
  if (schema === null || typeof schema !== "object") return 0;
  const s = schema as Json;
  let n = Array.isArray(s.type) || Array.isArray(s.anyOf) ? 1 : 0;
  for (const v of Object.values(s)) n += countUnionParams(v);
  return n;
}

// ---- approach B tools ---------------------------------------------------------------------

export interface ToolDef {
  name: string;
  description: string;
  parameters: Json;
}

export const TOOLS: ToolDef[] = [
  {
    name: "find_flight",
    description:
      "Find the flights on frequency that match a callsign as the controller said it (it may be misheard), " +
      "e.g. 'Delta four', 'Qatary seven zero one'. Returns matching flights with their state: role, position, " +
      "clearance, last pilot transmission. If nothing matches, returns every flight on frequency.",
    parameters: obj({ spoken_callsign: str("The callsign words from the transcript") }),
  },
  {
    name: "check_names",
    description:
      "Check taxiway, runway and terminal-ramp names against JFK's airport data. Give each name as spoken " +
      "('Kilo Echo', 'three one left', 'Terminal Four') or as an ID ('KE'). Returns the airport ID for each, " +
      "or 'unknown' with the closest IDs.",
    parameters: obj({ names: { type: "array", items: str() } }),
  },
];
