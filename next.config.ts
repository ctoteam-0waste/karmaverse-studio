import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The local JSON database is read and written with Node's fs module,
  // so every page that touches data renders on the server at request time.
  poweredByHeader: false,
  // ffmpeg-static finds its binary relative to its own folder, so it must not be bundled.
  serverExternalPackages: ["ffmpeg-static"],
};

export default nextConfig;
