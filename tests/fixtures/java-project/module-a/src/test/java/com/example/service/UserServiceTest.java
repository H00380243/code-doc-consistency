package com.example.service;

import com.example.entity.User;
import com.example.service.UserService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest
class UserServiceTest {

    @Autowired
    private UserService userService;

    @Test
    void testCreateUser() {
        User user = userService.createUser("testuser", "test@example.com");
        assertNotNull(user);
        assertEquals("testuser", user.getUserName());
        assertEquals("test@example.com", user.getEmail());
    }

    @Test
    void testGetUser() {
        User created = userService.createUser("getuser", "get@example.com");
        User found = userService.getUser(created.getId());
        assertEquals(created.getId(), found.getId());
    }
}
