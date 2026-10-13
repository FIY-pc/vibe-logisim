package com.cburch.logisim.circuit;

import com.cburch.logisim.comp.Component;
import com.cburch.logisim.comp.EndData;
import com.cburch.logisim.std.arith.Adder;
import com.cburch.logisim.std.memory.Register;
import java.io.File;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.Map;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;

/** Read-only semantics calibrated against the actual HUST/ITA implementations.
 *
 * Adder declares C_OUT as INPUT, but propagate reads 0/1/3 and writes 2/4.
 * Both Register implementations use Q/D/CK/CLR/EN/CS/PRE at indices 0..6.
 * Match the exact loaded factory class and its defining archive's class bytes;
 * names, subclasses, tooltips and parent-loader resource fallbacks are not proof.
 */
public final class NativePortSemantics {
    private NativePortSemantics() {}

    private static final String[] REGISTER_ROLES = {
        "q", "d", "clock", "clear", "enable", "chipSelect", "preset"
    };

    private static final ClassValue<String> VERIFIED_CLASS_SHA256 = new ClassValue<String>() {
        @Override protected String computeValue(Class<?> type) {
            if (type != Adder.class && type != Register.class) return "";
            try {
                File archive = new File(type.getProtectionDomain().getCodeSource().getLocation().toURI());
                try (JarFile jar = new JarFile(archive)) {
                    JarEntry entry = jar.getJarEntry(type.getName().replace('.', '/') + ".class");
                    if (entry == null) return "";
                    MessageDigest digest = MessageDigest.getInstance("SHA-256");
                    try (InputStream input = jar.getInputStream(entry)) {
                        byte[] buffer = new byte[8192];
                        int count;
                        while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
                    }
                    StringBuilder hex = new StringBuilder();
                    for (byte value : digest.digest()) hex.append(String.format("%02x", value & 0xff));
                    String sha = hex.toString();
                    if (type == Adder.class && (
                        sha.equals("6f38897949b589c202f3823c8d9c61fed99a627d563509e277f064ca7709866d") ||
                        sha.equals("c689d855b9e1cee75712df41347b520e5cfc2f6c33037545a904e4be431ad3a2"))) return sha;
                    if (type == Register.class && (
                        sha.equals("365de402742cce6bc23223c10b24dd9004cd88a7140240972fffd08229d77205") ||
                        sha.equals("5193cc3414285a1d217140e6dd415fe7a41d03c7c802fde50cc6708e6d01d5af"))) return sha;
                }
            } catch (Exception unavailable) {
                // An unverified implementation keeps its native declaration.
            }
            return "";
        }
    };

    private static String verifiedSha(Component component) {
        return VERIFIED_CLASS_SHA256.get(component.getFactory().getClass());
    }

    public static String nativeDirection(EndData end) {
        if (end.isInput() && end.isOutput()) return "inout";
        if (end.isInput()) return "input";
        if (end.isOutput()) return "output";
        return "none";
    }

    /** Only the returned observation changes; EndData, Port and exclusivity do not. */
    public static void putDirection(Map<String, Object> target, Component component, int index) {
        EndData end = component.getEnd(index);
        String nativeDirection = nativeDirection(end);
        target.put("direction", nativeDirection);
        if (component.getFactory().getClass() == Adder.class && index == 4 &&
                component.getEnds().size() == 5 && end.getWidth().getWidth() == 1 &&
                nativeDirection.equals("input")) {
            String sha = verifiedSha(component);
            if (!sha.isEmpty()) {
                target.put("direction", "output");
                target.put("nativeDirection", nativeDirection);
                target.put("directionSource", "verified-class-sha256:" + sha);
            }
        }
    }

    public static boolean isVerifiedRegister(Component component) {
        return component.getFactory().getClass() == Register.class &&
            component.getEnds().size() == REGISTER_ROLES.length && !verifiedSha(component).isEmpty();
    }

    public static String registerRole(Component component, int index) {
        return isVerifiedRegister(component) && index >= 0 && index < REGISTER_ROLES.length
            ? REGISTER_ROLES[index] : null;
    }

    public static String registerProfile(Component component) {
        return isVerifiedRegister(component) ? "verified-class-sha256:" + verifiedSha(component) : null;
    }
}
