// Envoi d'emails via Resend (utilisé par les invitations et les réinitialisations)

// Vérifier que la clé API et l'adresse d'expédition sont configurées
export function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL)
}

// Envoyer un email ; renvoie true si Resend l'a accepté, false sinon (sans jamais lever d'exception).
// L'appelant décide s'il attend le résultat ou non.
export async function sendEmail(message: { to: string; subject: string; text: string }) {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM_EMAIL
  if (!apiKey || !from) {
    return false
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    return response.ok
  } catch {
    return false
  }
}
