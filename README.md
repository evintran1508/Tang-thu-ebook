# Tàng Thư (The Open Archive Library)

> A modern, zero-dependency web reader designed for browsing and reading high-resolution original printed book scans.

---

## Overview

**Tàng Thư** is a fast, lightweight digital library web application designed to deliver an authentic, paper-like reading experience for scanned historic books, literature, and manuscripts. Built with pure vanilla web technologies and an offline-first architecture, it provides hardware-accelerated 3D page-flip animations, intelligent image caching, and integrated reading tools.

---

## Key Features

### 📖 Authentic Scan Reader
- **3D Soft Page-Curl Animation**: Drag-and-hold interactive paper curl physics using CSS 3D transforms.
- **Multiple Reading Modes**:
  - Double-page spread (standard book view)
  - Single-page view (optimized for mobile/tablets)
  - Multi-page thumbnail contact-sheet for instant page jumping
- **High-Definition Zoom**: Zoom from 75% to 250% with smooth panning and automatic resolution upscaling to 1600px. Remembers zoom levels on a per-book basis.
- **Immersive Fullscreen**: Clean, distraction-free reading mode with retained essential toolbar navigation.

### 🎧 Read Aloud (Text-to-Speech)
- Synchronized reading using Web Speech API with automatic detection of natural Vietnamese voices (`vi-VN`).
- Page-by-page OCR alignment using exact form-feed page boundaries.
- Interactive pause, resume, and rate control.

### 🔖 In-Book Reading Tools
- **Bookmarks**: Bookmark individual pages; bookmarked leaves display a ribbon badge in the thumbnail grid.
- **Page Notes**: Add and edit custom notes tied to specific page numbers.
- **In-Book Search**: Full-text keyword search across OCR layers with highlighted snippets and one-click navigation.
- **Secondary Text Reader (OCR)**: Toggleable lightweight text mode with adjustable font sizes and three reading themes (Light, Sepia, Dark).

### 📚 Interactive Library & 3D Bookshelf
- **Zero-Reflow 3D Carousel**: Mathematical perspective bookshelf with smooth mouse hover tracking.
- **Grid View**: Responsive card grid with lazy-loaded thumbnails.
- **Instant Launch**: Loads curated seed catalog in 0ms without waiting for remote network calls.
- **Search & Filters**: Multi-axis filtering by genre, era, language, author, and popularity ranking.
- **Resume Reading Widget**: Compact home screen bar featuring the active book cover, reading percentage, and quick-resume button.

### ⚡ Performance & Progressive Web App (PWA)
- **Service Worker Cache-First**: Caches scanned page images as you read, enabling instant re-reads and offline capability.
- **Adaptive Preloading**: Direction-aware preloading that prioritizes upcoming pages and downscales image widths on slower connections (`2G`/`3G`/`Save-Data`).
- **PWA Ready**: Includes web manifest and app icons for installation on iOS, Android, and desktop.
- **Robust Local Sync**: Client state and reading progress sync cleanly with local disk storage (`data/userdata.json`).

---

## Tech Stack

- **Frontend**: Vanilla JavaScript (ES Modules), HTML5, CSS3 (No bundlers, no npm frontend dependencies).
- **Backend / Local Server**: Native Node.js HTTP server (`server.mjs`) handling static assets, PWA manifest, and RESTful disk persistence API.

---

## Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher recommended)

### Running the App
1. Start the server:
   ```bash
   node server.mjs
   ```
2. Open your browser and navigate to:
   ```
   http://localhost:4173
   ```

### Running the Verification Suite
To run the automated verification and security test suite:
```bash
node test.mjs
```

---

## License

Personal and educational open-source use.

