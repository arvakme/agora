import type { APIRoute } from "astro";
import { href } from "../i18n";
import { llmsTxt } from "../repo";

export const GET: APIRoute = ({ site }) => new Response(llmsTxt(new URL(href("/"), site)), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
