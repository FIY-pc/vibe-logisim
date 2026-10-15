package com.cburch.logisim.file;

/**
 * An expected failure with a stable code for the host. The message is the same
 * text callers received before codes existed, so editor and verifier replies
 * that only read {@link #getMessage()} are unchanged.
 */
public final class SessionError extends IllegalArgumentException {
    public final String code;

    public SessionError(String code, String message) {
        super(message);
        this.code = code;
    }

    /** The stable code of a failure, or null when the failure was not expected. */
    static String code(Throwable error) {
        return error instanceof SessionError ? ((SessionError)error).code : null;
    }
}
