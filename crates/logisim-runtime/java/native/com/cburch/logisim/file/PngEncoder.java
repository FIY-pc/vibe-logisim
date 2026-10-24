package com.cburch.logisim.file;

import java.awt.image.BufferedImage;
import java.awt.image.DataBufferInt;
import java.awt.image.Raster;
import java.awt.image.SinglePixelPackedSampleModel;
import java.io.ByteArrayOutputStream;
import java.util.zip.CRC32;
import java.util.zip.Deflater;

/**
 * PNG for the pictures the window shows: 8-bit RGB, or RGBA when the image
 * has alpha, rows unfiltered, the fastest deflate level. The pictures are
 * line art on a white page and never leave the machine; ImageIO's writer
 * spends about five times as long per picture trying every row filter for
 * a file two thirds the size.
 */
public final class PngEncoder {
    private static final byte[] SIGNATURE = {(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'};

    private PngEncoder() {}

    public static byte[] encode(BufferedImage image) {
        int width = image.getWidth(), height = image.getHeight();
        boolean alpha = image.getColorModel().hasAlpha();
        int channels = alpha ? 4 : 3;
        int[] packed = packed(image);
        int[] line = packed == null ? new int[width] : null;
        ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024 + width * height / 2);
        out.write(SIGNATURE, 0, SIGNATURE.length);
        byte[] header = new byte[13];
        putInt(header, 0, width);
        putInt(header, 4, height);
        header[8] = 8;
        header[9] = (byte) (alpha ? 6 : 2);
        chunk(out, "IHDR", header, header.length);
        ByteArrayOutputStream data = new ByteArrayOutputStream(64 * 1024 + width * height / 2);
        Deflater deflater = new Deflater(Deflater.BEST_SPEED);
        try {
            byte[] row = new byte[1 + width * channels], buffer = new byte[64 * 1024];
            for (int y = 0; y < height; y++) {
                int[] source = packed;
                int offset = y * width;
                if (source == null) {
                    image.getRGB(0, y, width, 1, line, 0, width);
                    source = line;
                    offset = 0;
                }
                // row[0] stays 0: no filter.
                for (int x = 0, i = 1; x < width; x++) {
                    int p = source[offset + x];
                    row[i++] = (byte) (p >>> 16);
                    row[i++] = (byte) (p >>> 8);
                    row[i++] = (byte) p;
                    if (alpha) row[i++] = (byte) (p >>> 24);
                }
                deflater.setInput(row);
                while (!deflater.needsInput()) data.write(buffer, 0, deflater.deflate(buffer));
            }
            deflater.finish();
            while (!deflater.finished()) data.write(buffer, 0, deflater.deflate(buffer));
        } finally {
            deflater.end();
        }
        chunk(out, "IDAT", data.toByteArray(), data.size());
        chunk(out, "IEND", new byte[0], 0);
        return out.toByteArray();
    }

    /** The image's own pixels as packed ARGB rows, when that is how it stores them. */
    private static int[] packed(BufferedImage image) {
        int type = image.getType();
        if (type != BufferedImage.TYPE_INT_RGB && type != BufferedImage.TYPE_INT_ARGB) return null;
        Raster raster = image.getRaster();
        if (!(raster.getDataBuffer() instanceof DataBufferInt) || raster.getDataBuffer().getNumBanks() != 1
            || !(raster.getSampleModel() instanceof SinglePixelPackedSampleModel)
            || ((SinglePixelPackedSampleModel) raster.getSampleModel()).getScanlineStride() != image.getWidth()
            || raster.getSampleModelTranslateX() != 0 || raster.getSampleModelTranslateY() != 0
            || raster.getDataBuffer().getOffset() != 0) return null;
        return ((DataBufferInt) raster.getDataBuffer()).getData();
    }

    private static void chunk(ByteArrayOutputStream out, String type, byte[] body, int length) {
        byte[] head = new byte[8];
        putInt(head, 0, length);
        for (int i = 0; i < 4; i++) head[4 + i] = (byte) type.charAt(i);
        out.write(head, 0, 8);
        out.write(body, 0, length);
        CRC32 crc = new CRC32();
        crc.update(head, 4, 4);
        crc.update(body, 0, length);
        byte[] tail = new byte[4];
        putInt(tail, 0, (int) crc.getValue());
        out.write(tail, 0, 4);
    }

    private static void putInt(byte[] bytes, int at, int value) {
        bytes[at] = (byte) (value >>> 24);
        bytes[at + 1] = (byte) (value >>> 16);
        bytes[at + 2] = (byte) (value >>> 8);
        bytes[at + 3] = (byte) value;
    }
}
