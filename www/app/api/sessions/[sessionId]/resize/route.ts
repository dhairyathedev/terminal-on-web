import { NextRequest, NextResponse } from 'next/server'

export async function POST(
  request: NextRequest,
  { params }: { params: { sessionId: string } }
) {
  const { cols, rows } = await request.json()
  const { sessionId } = params

  // Here you would typically send this information to your backend
  // For now, we'll just log it and return a success response
  console.log(`Resizing session ${sessionId} to ${cols}x${rows}`)

  return NextResponse.json({ success: true })
}

