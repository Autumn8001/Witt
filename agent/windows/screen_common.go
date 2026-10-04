package main

import (
	"bytes"
	"errors"
	"image"
	"image/jpeg"
)

const maxScreenshotDimension = 1440

// scaleScreenshot keeps the capture bounded before JPEG encoding. It uses a
// deterministic nearest-neighbour pass so the Windows and test paths do not
// need a graphics or image dependency beyond the standard library.
func scaleScreenshot(src image.Image) image.Image {
	if src == nil {
		return nil
	}
	bounds := src.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width <= 0 || height <= 0 {
		return nil
	}
	longest := width
	if height > longest {
		longest = height
	}
	if longest <= maxScreenshotDimension {
		return src
	}
	scale := float64(maxScreenshotDimension) / float64(longest)
	newWidth := max(1, int(float64(width)*scale+0.5))
	newHeight := max(1, int(float64(height)*scale+0.5))
	dst := image.NewRGBA(image.Rect(0, 0, newWidth, newHeight))
	for y := 0; y < newHeight; y++ {
		sourceY := bounds.Min.Y + y*height/newHeight
		for x := 0; x < newWidth; x++ {
			sourceX := bounds.Min.X + x*width/newWidth
			dst.Set(x, y, src.At(sourceX, sourceY))
		}
	}
	return dst
}

// encodeScreenshot applies the product's hard attachment limit and emits a
// valid JPEG. The quality fallback is deterministic and never returns a
// payload larger than the WebSocket attachment limit.
func encodeScreenshot(src image.Image) ([]byte, error) {
	img := scaleScreenshot(src)
	if img == nil {
		return nil, errors.New("SCREEN_CAPTURE_FAILED")
	}
	for quality := 90; quality >= 20; quality -= 10 {
		var encoded bytes.Buffer
		if err := jpeg.Encode(&encoded, img, &jpeg.Options{Quality: quality}); err != nil {
			return nil, errors.New("SCREEN_CAPTURE_FAILED")
		}
		data := encoded.Bytes()
		if len(data) <= maxScreenshotBytes && len(data) >= 4 &&
			bytes.HasPrefix(data, []byte{0xff, 0xd8}) && bytes.HasSuffix(data, []byte{0xff, 0xd9}) {
			return append([]byte(nil), data...), nil
		}
	}
	return nil, errors.New("SCREEN_CAPTURE_TOO_LARGE")
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
