import express from "express"

const app = express()
const PORT = 3000

app.get("/tickets", (req, res) => {
  res.json([])
})

app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`)
})
