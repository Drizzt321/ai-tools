/**
 * MistralTransport.ts -- the network seam for the Mistral vendor client.
 *
 * The ONLY code in mistral/ that touches the network. It performs one HTTP POST and
 * returns the raw outcome; it knows nothing about verdicts, models, or schemas -- that
 * all lives in MistralClient.ts, which takes a transport and is tested against fakes.
 *
 * Why a seam: v1 talks to the REST API with plain fetch (no SDK, no runtime deps). If the
 * official @mistralai/mistralai SDK is adopted later, it becomes a second implementation
 * of this type (or an adapter around it); request building, response parsing and the
 * verdict mapping in MistralClient stay as they are, and so do their tests.
 *
 * Contract: resolves for ANY HTTP status (the caller maps status -> verdict); rejects only
 * on transport failure (DNS, connection reset) or abort. Never logs the key.
 *
 * toolset-version: 0.1.0
 */

export interface TransportRequest {
  /** Full endpoint URL. */
  url: string;
  /** API key, sent as `Authorization: Bearer <key>`. Never logged. */
  apiKey: string;
  /** Request body, serialized as JSON. */
  body: object;
  /** Abort signal (timeout and/or caller cancellation). */
  signal: AbortSignal;
}

export interface TransportResponse {
  /** HTTP status code. */
  status: number;
  /** Response headers, names lower-cased. */
  headers: Record<string, string>;
  /** Parsed JSON body, or null when the body is not valid JSON. */
  json: unknown;
  /** The raw body text. */
  rawText: string;
}

export type MistralTransport = (req: TransportRequest) => Promise<TransportResponse>;

/** The default transport: one fetch POST. */
export const fetchTransport: MistralTransport = async (req) => {
  const res = await fetch(req.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(req.body),
    signal: req.signal,
  });

  const rawText = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(rawText);
  } catch {
    json = null; // non-JSON body (e.g. an HTML error page from a proxy)
  }

  const headers: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });

  return { status: res.status, headers, json, rawText };
};
