package com.example.common;

import java.util.UUID;
import java.time.Instant;

public class IdGenerator {

    public static String generateId() {
        return UUID.randomUUID().toString();
    }

    public static Instant now() {
        return Instant.now();
    }

    public static boolean isEmpty(String str) {
        return str == null || str.trim().isEmpty();
    }
}
