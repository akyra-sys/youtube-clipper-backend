const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");
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

let activeYoutubeJobs = 0;
const MAX_YOUTUBE_JOBS = 1;

function parseTime(value) {
    if (
        typeof value !== "string" &&
        typeof value !== "number"
    ) {
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

function validateTimes(startValue, endValue) {
    const start = parseTime(startValue);
    const end = parseTime(endValue);

    if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end <= start
    ) {
        throw new Error("Enter valid start and end times.");
    }

    if (end - start > 600) {
        throw new Error("Clips cannot exceed 10 minutes.");
    }

    return { start, end };
}

function validateYouTubeUrl(value) {
    if (typeof value !== "string" || value.length > 2048) {
        throw new Error("Enter a valid YouTube video URL.");
    }

    let url;

    try {
        url = new URL(value.trim());
    } catch {
        throw new Error("Enter a valid YouTube video URL.");
    }

    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("Only YouTube video URLs are accepted.");
    }

    const host = url.hostname.toLowerCase();

    const allowedHosts = [
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "youtu.be",
        "www.youtu.be"
    ];

    if (!allowedHosts.includes(host)) {
        throw new Error("Only YouTube video links are supported.");
    }

    let videoId = null;

    if (host.includes("youtu.be")) {
        videoId = url.pathname.split("/").filter(Boolean)[0];
    } else if (url.pathname === "/watch") {
        videoId = url.searchParams.get("v");
    } else {
        const match = url.pathname.match(
            /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]+)/
        );

        videoId = match ? match[1] : null;
    }

    if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        throw new Error("The URL does not contain a valid YouTube video ID.");
    }

    return `https://www.youtube.com/watch?v=${videoId}`;
}

function runProcess(command, args, timeoutMs = 300000) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ["ignore", "pipe", "pipe"]
        });

        let stdout = "";
        let stderr = "";
        let settled = false;

        const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            finish(new Error("The operation timed out."));
        }, timeoutMs);

        function finish(error, result) {
            if (settled) return;

            settled = true;
            clearTimeout(timeout);

            if (error) {
                reject(error);
            } else {
                resolve(result);
            }
        }

        child.stdout.on("data", data => {
            stdout += data.toString();

            if (stdout.length > 20000) {
                stdout = stdout.slice(-20000);
            }
        });

        child.stderr.on("data", data => {
            stderr += data.toString();

            if (stderr.length > 12000) {
                stderr = stderr.slice(-12000);
            }
        });

        child.on("error", error => {
            finish(error);
        });

        child.on("close", code => {
            if (code === 0) {
                finish(null, { stdout, stderr });
            } else {
                finish(
                    new Error(
                        `${command} exited with code ${code}. ${stderr.slice(-3000)}`
                    )
                );
            }
        });
    });
}

async function removeDirectory(directory) {
    if (directory) {
        await fs.promises.rm(directory, {
            recursive: true,
            force: true
        }).catch(() => {});
    }
}

function trimWithFFmpeg(inputPath, outputPath, start, end) {
    return runProcess("ffmpeg", [
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
    ], 300000);
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

app.get("/ffmpeg-check", (req, res) => {
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

app.get("/ytdlp-check", async (req, res) => {
    try {
        const result = await runProcess(
            "yt-dlp",
            ["--version"],
            15000
        );

        res.json({
            installed: true,
            version: result.stdout.trim()
        });
    } catch (error) {
        res.status(500).json({
            installed: false,
            error: error.message
        });
    }
});

/*
 * Existing feature:
 * Upload a local video and trim it.
 */
app.post("/trim", upload.single("video"), async (req, res) => {
    const inputPath = req.file?.path;
    let outputPath;

    try {
        if (!req.file) {
            return res.status(400).json({
                error: "Upload a video using the field name 'video'."
            });
        }

        const { start, end } = validateTimes(
            req.body.start,
            req.body.end
        );

        outputPath = path.join(
            UPLOAD_DIR,
            `${randomUUID()}.mp4`
        );

        await trimWithFFmpeg(inputPath, outputPath, start, end);

        res.download(outputPath, "clip.mp4", async error => {
            if (error) {
                console.error("Download error:", error.message);
            }

            await fs.promises.unlink(inputPath).catch(() => {});
            await fs.promises.unlink(outputPath).catch(() => {});
        });
    } catch (error) {
        console.error("Upload trimming error:", error.message);

        if (inputPath) {
            await fs.promises.unlink(inputPath).catch(() => {});
        }

        if (outputPath) {
            await fs.promises.unlink(outputPath).catch(() => {});
        }

        if (!res.headersSent) {
            res.status(400).json({
                error: error.message || "Video processing failed."
            });
        }
    }
});

/*
 * New feature:
 * Accept a YouTube URL, retrieve the video, trim it,
 * and return an MP4 clip.
 */
app.post("/trim-youtube", async (req, res) => {
    if (activeYoutubeJobs >= MAX_YOUTUBE_JOBS) {
        return res.status(429).json({
            error: "Another YouTube video is being processed. Try again shortly."
        });
    }

    let jobDirectory;
    let outputPath;
    let stage = "download";
    let slotReleased = false;

    activeYoutubeJobs++;

    function releaseSlot() {
        if (!slotReleased) {
            slotReleased = true;
            activeYoutubeJobs--;
        }
    }

    try {
        const url = validateYouTubeUrl(req.body.url);

        const { start, end } = validateTimes(
            req.body.start,
            req.body.end
        );

        jobDirectory = path.join(UPLOAD_DIR, randomUUID());

        await fs.promises.mkdir(jobDirectory, {
            recursive: true
        });

        outputPath = path.join(jobDirectory, "clip.mp4");

        const outputTemplate = path.join(
            jobDirectory,
            "source.%(ext)s"
        );

        console.log("Starting authorized YouTube clip job.");

        /*
         * Limit downloads to 500 MB.
         * Download only one video, not an entire playlist.
         */
        const downloadResult = await runProcess("yt-dlp", [
            "--no-playlist",
            "--no-warnings",
            "--no-progress",
            "--ignore-config",
            "--socket-timeout", "20",
            "--retries", "2",
            "--fragment-retries", "2",
            "--max-filesize", "500M",
            "--format", "bestvideo*+bestaudio/best",
            "--merge-output-format", "mkv",
            "--output", outputTemplate,
            "--print", "after_move:filepath",
            url
        ], 300000);

        const downloadedPath = downloadResult.stdout
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .pop();

        if (!downloadedPath) {
            throw new Error("The downloader did not return a video file.");
        }

        const resolvedPath = path.resolve(downloadedPath);
        const resolvedDirectory = path.resolve(jobDirectory);

        if (
            !resolvedPath.startsWith(resolvedDirectory + path.sep)
        ) {
            throw new Error("Unexpected downloaded file location.");
        }

        const fileStats = await fs.promises.stat(resolvedPath);

        if (!fileStats.isFile() || fileStats.size === 0) {
            throw new Error("The downloaded video file is empty.");
        }

        if (fileStats.size > 500 * 1024 * 1024) {
            throw new Error("The downloaded video exceeds 500 MB.");
        }

        stage = "trim";

        await trimWithFFmpeg(
            resolvedPath,
            outputPath,
            start,
            end
        );

        const outputStats = await fs.promises.stat(outputPath);

        if (outputStats.size === 0) {
            throw new Error("FFmpeg created an empty clip.");
        }

        /*
         * Keep the temporary files until the response finishes.
         */
        await new Promise((resolve, reject) => {
            res.download(outputPath, "clip.mp4", error => {
                if (error) {
                    console.error(
                        "YouTube clip download response error:",
                        error.message
                    );
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    } catch (error) {
        const details = error.message || "Unknown error";

        console.error(
            `YouTube ${stage} error:`,
            details
        );

        if (!res.headersSent && !res.destroyed) {
            let message;

            if (stage === "download") {
                if (
                    /sign in to confirm|not a bot/i.test(details)
                ) {
                    message =
                        "YouTube blocked this server's download request. " +
                        "Ask the video owner to provide the original video file, " +
                        "then use the Local Video File option.";
                } else if (/private video|members-only|join this channel/i.test(details)) {
                    message =
                        "This video is private or restricted. " +
                        "Ask the owner to provide an authorized video file.";
                } else if (/maximum filesize|file is larger than/i.test(details)) {
                    message =
                        "This video exceeds the downloader's size limit.";
                } else {
                    message =
                        "The backend could not download this video. " +
                        "Check the Render logs for the exact cause, " +
                        "or upload an authorized video file instead.";
                }
            } else {
                message =
                    "The video was retrieved, but trimming failed. " +
                    "Check the Render logs.";
            }

            res.status(500).json({
                error: message
            });
        }
    } finally {
        await removeDirectory(jobDirectory);
        releaseSlot();
    }
});

app.use((err, req, res, next) => {
    console.error("Request error:", err.message);

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

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Backend running on port ${PORT}`);
});
