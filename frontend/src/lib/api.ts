import { NextResponse } from "next/server";

export async function jsonRoute<T>(handler: () => Promise<T> | T) {
  try {
    return NextResponse.json(await handler());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
