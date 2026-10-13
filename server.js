const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(os.tmpdir(), "clipper-uploads");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const upload = multer({
    dest: UPLOAD_DIR,
    limits: {
        fileSize: 100 * 1024 * 1024
    },
    fileFilter: (req, file, callback) => {
        if (!file.mimetype.startsWith("video/")) {
            return callback(new Error("Please upload a video file."));
        }

        callback(null, true);
    }
});

function parseTime(value) {
    if (typeof value !== "string" &&
        typeof value !== "number") {
        return NaN;
    }

    const text = String(value).trim();

    if (/^\d+(\.\d+)?$/.test(text)) {
        return Number(text);
    }

    const parts = text.split(":");

    if (
        parts.length < 2 ||
        parts.length > 3 ||
        !parts.every(part => /^\d+(\.\d+)?$/.test(part))
    ) {
        return NaN;
    }

    if (parts.length === 2) {
        return Number(parts[0]) * 60 + Number(parts[1]);
    }

    return Number(parts[0]) * 3600
        + Number(parts[1]) * 60
        + Number(parts[2]);
}

app.get("/", (req, res) => {
    res.json({
        name: "YouTube Clip Extractor Backend",
        status: "online",
        message: "Video trimming API is ready."
    });
});

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        service: "youtube-clipper-backend"
    });
});

app.post("/trim", upload.single("video"), async (req, res) => {
    let inputPath = req.file?.path;
    let outputPath;

    try {
        if (!req.file) {
            return res.status(400).json({
                error: "Upload a video using the field name 'video'."
            });
        }

        const start = parseTime(req.body.start);
        const end = parseTime(req.body.end);

        if (
            !Number.isFinite(start) ||
            !Number.isFinite(end) ||
            start < 0 ||
            end <= start
        ) {
            await fs.promises.unlink(inputPath).catch(() => {});

            return res.status(400).json({
                error: "Invalid start or end time."
            });
        }

        if (end - start > 600) {
            await fs.promises.unlink(inputPath).catch(() => {});

            return res.status(400).json({
                error: "Clips cannot exceed 10 minutes."
            });
        }

        outputPath = path.join(UPLOAD_DIR, `${randomUUID()}.mp4`);

        const args = [
            "-hide_banner",
            "-loglevel", "error",
            "-y",
            "-ss", String(start),
            "-i", inputPath,
            "-t", String(end - start),
            "-map", "0:v:0",
            "-map", "0:a?",
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "23",
            "-c:a", "aac",
            "-movflags", "+faststart",
            "-threads", "2",
            outputPath
        ];

        const ffmpeg = spawn("ffmpeg", args);
        let errorOutput = "";

        ffmpeg.stderr.on("data", data => {
            errorOutput += data.toString();

            if (errorOutput.length > 12000) {
                errorOutput = errorOutput.slice(-12000);
            }
        });

        ffmpeg.on("error", error => {
            console.error("FFmpeg startup error:", error);
        });

        ffmpeg.on("close", async code => {
            if (code !== 0) {
                console.error("FFmpeg failed:", errorOutput);

                await fs.promises.unlink(inputPath).catch(() => {});
                await fs.promises.unlink(outputPath).catch(() => {});

                if (!res.headersSent) {
                    res.status(500).json({
                        error: "Video processing failed."
                    });
                }

                return;
            }

            res.download(outputPath, "clip.mp4", async error => {
                await fs.promises.unlink(inputPath).catch(() => {});
                await fs.promises.unlink(outputPath).catch(() => {});

                if (error) {
                    console.error("Download error:", error.message);
                }
            });
        });
    } catch (error) {
        console.error(error);

        if (inputPath) {
            await fs.promises.unlink(inputPath).catch(() => {});
        }

        if (outputPath) {
            await fs.promises.unlink(outputPath).catch(() => {});
        }

        if (!res.headersSent) {
            res.status(500).json({
                error: "An unexpected server error occurred."
            });
        }
    }
});

app.use((err, req, res, next) => {
    console.error(err.message);

    if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({
                error: "The maximum upload size is 100 MB."
            });
        }

        return res.status(400).json({
            error: err.message
        });
    }

    res.status(400).json({
        error: err.message || "Request failed."
    });
});
app.get("/ffmpeg-check", (req, res) => {
    const { execFile } = require("child_process");

    execFile("ffmpeg", ["-version"], (error, stdout) => {
        if (error) {
            return res.status(500).json({
                installed: false,
                error: error.message
            });
        }

        res.json({
            installed: true,
            version: stdout.split("\n")[0]
        });
    });
});
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Backend running on port ${PORT}`);
});
