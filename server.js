const express = require("express");
const multer = require("multer");
const fs = require("fs");

const app = express();

app.use("/uploads", express.static("uploads"));

const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});

const upload = multer({ storage });

app.post("/upload", upload.single("song"), (req, res) => {
  res.redirect("/");
});

app.get("/songs", (req, res) => {
  fs.readdir("uploads", (err, files) => {
    res.json(files);
  });
});

app.listen(3000, () => console.log("Server running on http://localhost:3000"));
