const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// Allow your GitHub Pages frontend to contact this API.
// We will restrict this to your website in a later step.
app.use(cors());

app.use(express.json({ limit: "1mb" }));

// Basic homepage
app.get("/", (req, res) => {
  res.json({
    name: "YouTube Clip Extractor Backend",
    status: "online",
    message: "Your backend is running."
  });
});

// Health-check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "youtube-clipper-backend"
  });
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend running on port ${PORT}`);
});
