//go:build windows

package main

import (
	"context"
	"errors"
	"image"
	"syscall"
	"unsafe"
)

const (
	smXVirtualScreen  = 76
	smYVirtualScreen  = 77
	smCXVirtualScreen = 78
	smCYVirtualScreen = 79
	biRGB             = 0
	dibRGBColors      = 0
	srccopy           = 0x00cc0020
	captureBLT        = 0x40000000
	maxCapturePixels  = 64 * 1024 * 1024
)

var (
	user32DLL            = syscall.NewLazyDLL("user32.dll")
	gdi32DLL             = syscall.NewLazyDLL("gdi32.dll")
	getDCProc            = user32DLL.NewProc("GetDC")
	releaseDCProc        = user32DLL.NewProc("ReleaseDC")
	getSystemMetricsProc = user32DLL.NewProc("GetSystemMetrics")
	createCompatibleDC   = gdi32DLL.NewProc("CreateCompatibleDC")
	deleteDCProc         = gdi32DLL.NewProc("DeleteDC")
	createCompatibleBmp  = gdi32DLL.NewProc("CreateCompatibleBitmap")
	deleteObjectProc     = gdi32DLL.NewProc("DeleteObject")
	selectObjectProc     = gdi32DLL.NewProc("SelectObject")
	bitBltProc           = gdi32DLL.NewProc("BitBlt")
	getDIBitsProc        = gdi32DLL.NewProc("GetDIBits")
)

type bitmapInfoHeader struct {
	size            uint32
	width           int32
	height          int32
	planes          uint16
	bitCount        uint16
	compression     uint32
	sizeImage       uint32
	xPixelsPerM     int32
	yPixelsPerM     int32
	colorsUsed      uint32
	colorsImportant uint32
}

type bitmapInfo struct {
	header bitmapInfoHeader
	color  [4]byte
}

func captureScreen(ctx context.Context) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, errors.New("COMMAND_TIMEOUT")
		}
		return nil, errors.New("SCREEN_CAPTURE_FAILED")
	}
	xValue, _, _ := getSystemMetricsProc.Call(uintptr(smXVirtualScreen))
	yValue, _, _ := getSystemMetricsProc.Call(uintptr(smYVirtualScreen))
	widthValue, _, _ := getSystemMetricsProc.Call(uintptr(smCXVirtualScreen))
	heightValue, _, _ := getSystemMetricsProc.Call(uintptr(smCYVirtualScreen))
	x := int32(xValue)
	y := int32(yValue)
	width := int32(widthValue)
	height := int32(heightValue)
	if width <= 0 || height <= 0 || int64(width)*int64(height) > maxCapturePixels {
		return nil, errors.New("SCREEN_CAPTURE_TOO_LARGE")
	}

	screenDC, _, _ := getDCProc.Call(0)
	if screenDC == 0 {
		return nil, errors.New("SCREEN_CAPTURE_FAILED")
	}
	defer releaseDCProc.Call(0, screenDC)

	memoryDC, _, _ := createCompatibleDC.Call(screenDC)
	if memoryDC == 0 {
		return nil, errors.New("SCREEN_CAPTURE_FAILED")
	}
	defer deleteDCProc.Call(memoryDC)

	bitmap, _, _ := createCompatibleBmp.Call(screenDC, uintptr(uint32(width)), uintptr(uint32(height)))
	if bitmap == 0 {
		return nil, errors.New("SCREEN_CAPTURE_FAILED")
	}
	defer deleteObjectProc.Call(bitmap)

	oldObject, _, _ := selectObjectProc.Call(memoryDC, bitmap)
	if oldObject == 0 {
		return nil, errors.New("SCREEN_CAPTURE_FAILED")
	}
	bitBltResult, _, _ := bitBltProc.Call(memoryDC, 0, 0, uintptr(uint32(width)), uintptr(uint32(height)),
		screenDC, uintptr(uint32(x)), uintptr(uint32(y)), uintptr(srccopy|captureBLT))
	// GetDIBits requires the bitmap not to be selected in a DC. Always restore
	// the previous object before inspecting the captured pixels.
	selectObjectProc.Call(memoryDC, oldObject)
	if bitBltResult == 0 {
		return nil, errors.New("SCREEN_CAPTURE_FAILED")
	}
	if err := ctx.Err(); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, errors.New("COMMAND_TIMEOUT")
		}
		return nil, errors.New("SCREEN_CAPTURE_FAILED")
	}

	rowBytes := int(width) * 4
	pixels := make([]byte, rowBytes*int(height))
	info := bitmapInfo{header: bitmapInfoHeader{
		size:        uint32(unsafe.Sizeof(bitmapInfoHeader{})),
		width:       width,
		height:      -height, // top-down DIB; supports virtual screens without row reversal
		planes:      1,
		bitCount:    32,
		compression: biRGB,
		sizeImage:   uint32(len(pixels)),
	}}
	copied, _, _ := getDIBitsProc.Call(screenDC, bitmap, 0, uintptr(uint32(height)),
		uintptr(unsafe.Pointer(&pixels[0])), uintptr(unsafe.Pointer(&info)), dibRGBColors)
	if copied != uintptr(uint32(height)) {
		return nil, errors.New("SCREEN_CAPTURE_FAILED")
	}

	imageBuffer := image.NewRGBA(image.Rect(0, 0, int(width), int(height)))
	for row := 0; row < int(height); row++ {
		source := pixels[row*rowBytes : (row+1)*rowBytes]
		destination := imageBuffer.Pix[row*imageBuffer.Stride : (row+1)*imageBuffer.Stride]
		for column := 0; column < int(width); column++ {
			sourceOffset := column * 4
			destinationOffset := column * 4
			// GDI's 32-bit BI_RGB layout is B, G, R, unused.
			destination[destinationOffset] = source[sourceOffset+2]
			destination[destinationOffset+1] = source[sourceOffset+1]
			destination[destinationOffset+2] = source[sourceOffset]
			destination[destinationOffset+3] = 0xff
		}
	}
	return encodeScreenshot(imageBuffer)
}
