package com.cburch.logisim.file;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * The element structure of a project file as byte ranges, found by scanning
 * the markup without building a tree: the root's start tag and its direct
 * children, and on request the children of one of them. Only what Logisim
 * reads is distinguished; text, comments and processing instructions are
 * skipped. A file this cannot scan (a document type declaration, unbalanced
 * markup) throws, and the caller loads it the ordinary way.
 */
final class FileLayout {
    /** One element: {@code [start, open)} is its start tag, {@code [start, end)} all of it. */
    static final class Node {
        final String tag;
        final int start, open, end;

        Node(String tag, int start, int open, int end) {
            this.tag = tag;
            this.start = start;
            this.open = open;
            this.end = end;
        }

        boolean empty() { return open == end; }
    }

    final byte[] bytes;
    /** Everything before the root's content: the XML declaration and the root start tag. */
    final int prolog;
    final String root;
    /** The root's start tag. */
    final Node top;
    final List<Node> children;

    FileLayout(byte[] bytes) {
        this.bytes = bytes;
        int i = 0;
        while (true) {
            i = next(bytes, i);
            if (bytes[i + 1] == '?' || bytes[i + 1] == '!') i = skipMarkup(bytes, i);
            else break;
        }
        int open = tagEnd(bytes, i);
        if (bytes[open - 2] == '/') throw new IllegalArgumentException("empty project");
        root = tag(bytes, i);
        top = new Node(root, i, open, open);
        prolog = open;
        children = children(open);
    }

    /** The direct child elements of the content that starts at {@code from}. */
    List<Node> children(int from) {
        List<Node> result = new ArrayList<>();
        int i = from;
        while (true) {
            i = next(bytes, i);
            byte kind = bytes[i + 1];
            if (kind == '/') return result;
            if (kind == '!' || kind == '?') {
                i = skipMarkup(bytes, i);
                continue;
            }
            int open = tagEnd(bytes, i);
            int end = bytes[open - 2] == '/' ? open : elementEnd(bytes, open);
            result.add(new Node(tag(bytes, i), i, open, end));
            i = end;
        }
    }

    /** The children of an element; an empty element has none. */
    List<Node> children(Node node) {
        return node.empty() ? new ArrayList<Node>() : children(node.open);
    }

    boolean same(Node node, FileLayout other, Node otherNode) {
        return Arrays.equals(bytes, node.start, node.end, other.bytes, otherNode.start, otherNode.end);
    }

    boolean sameStartTag(Node node, FileLayout other, Node otherNode) {
        return Arrays.equals(bytes, node.start, node.open, other.bytes, otherNode.start, otherNode.open);
    }

    boolean sameProlog(FileLayout other) {
        return Arrays.equals(bytes, 0, prolog, other.bytes, 0, other.prolog);
    }

    /**
     * The value of an attribute of an element's start tag with the XML
     * escapes resolved, or null when the tag has no such attribute.
     */
    String attribute(Node node, String name) {
        byte[] key = name.getBytes(StandardCharsets.UTF_8);
        int i = node.start + 1;
        while (i < node.open && !space(bytes[i]) && bytes[i] != '>' && bytes[i] != '/') i++;
        while (i < node.open) {
            while (i < node.open && (space(bytes[i]) || bytes[i] == '/' || bytes[i] == '>')) i++;
            if (i >= node.open) return null;
            int nameStart = i;
            while (bytes[i] != '=' && !space(bytes[i])) i++;
            int nameEnd = i;
            while (bytes[i] != '"' && bytes[i] != '\'') i++;
            byte quote = bytes[i];
            int valueStart = ++i;
            while (bytes[i] != quote) i++;
            int valueEnd = i++;
            if (Arrays.equals(bytes, nameStart, nameEnd, key, 0, key.length))
                return unescape(new String(bytes, valueStart, valueEnd - valueStart, StandardCharsets.UTF_8));
        }
        return null;
    }

    private static String unescape(String value) {
        if (value.indexOf('&') < 0) return value;
        StringBuilder out = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c != '&') {
                out.append(c);
                continue;
            }
            int semi = value.indexOf(';', i);
            if (semi < 0) throw new IllegalArgumentException("bad reference");
            String ref = value.substring(i + 1, semi);
            if (ref.equals("amp")) out.append('&');
            else if (ref.equals("lt")) out.append('<');
            else if (ref.equals("gt")) out.append('>');
            else if (ref.equals("quot")) out.append('"');
            else if (ref.equals("apos")) out.append('\'');
            else if (ref.startsWith("#x")) out.appendCodePoint(Integer.parseInt(ref.substring(2), 16));
            else if (ref.startsWith("#")) out.appendCodePoint(Integer.parseInt(ref.substring(1)));
            else throw new IllegalArgumentException("bad reference");
            i = semi;
        }
        return out.toString();
    }

    private static boolean space(byte b) {
        return b == ' ' || b == '\t' || b == '\n' || b == '\r';
    }

    private static int next(byte[] b, int i) {
        while (b[i] != '<') i++;
        return i;
    }

    private static String tag(byte[] b, int start) {
        int i = start + 1;
        while (!space(b[i]) && b[i] != '>' && b[i] != '/') i++;
        return new String(b, start + 1, i - start - 1, StandardCharsets.UTF_8);
    }

    /** The index after the '>' of the tag at {@code start}, skipping quoted values. */
    private static int tagEnd(byte[] b, int start) {
        int i = start + 1;
        while (true) {
            byte c = b[i];
            if (c == '"' || c == '\'') {
                i++;
                while (b[i] != c) i++;
            } else if (c == '>') {
                return i + 1;
            }
            i++;
        }
    }

    private static int find(byte[] b, int from, String terminator) {
        byte[] t = terminator.getBytes(StandardCharsets.US_ASCII);
        outer:
        for (int i = from; ; i++) {
            for (int j = 0; j < t.length; j++) if (b[i + j] != t[j]) continue outer;
            return i + t.length;
        }
    }

    /** Skips a comment, CDATA section or processing instruction; rejects declarations. */
    private static int skipMarkup(byte[] b, int i) {
        if (b[i + 1] == '?') return find(b, i + 2, "?>");
        if (b[i + 2] == '-' && b[i + 3] == '-') return find(b, i + 4, "-->");
        if (b[i + 2] == '[' && b[i + 3] == 'C') return find(b, i + 3, "]]>");
        throw new IllegalArgumentException("unsupported markup");
    }

    /** The index after the end tag of the element whose content starts at {@code from}. */
    private static int elementEnd(byte[] b, int from) {
        int depth = 1, i = from;
        while (true) {
            i = next(b, i);
            byte kind = b[i + 1];
            if (kind == '/') {
                i = tagEnd(b, i);
                if (--depth == 0) return i;
            } else if (kind == '!' || kind == '?') {
                i = skipMarkup(b, i);
            } else {
                i = tagEnd(b, i);
                if (b[i - 2] != '/') depth++;
            }
        }
    }
}
