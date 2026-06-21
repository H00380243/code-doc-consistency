package com.example.service;

import com.example.entity.User;
import com.example.entity.UserStatus;
import com.example.repository.UserRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.cache.annotation.CacheEvict;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.util.List;
import java.util.Optional;

@Service
@Transactional
public class UserService {

    private final UserRepository userRepository;

    @Autowired
    public UserService(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    @Cacheable(value = "users", key = "#id")
    @Transactional(readOnly = true)
    public User getUser(Long id) {
        return userRepository.findById(id)
            .orElseThrow(() -> new RuntimeException("User not found: " + id));
    }

    @Transactional(readOnly = true)
    public Optional<User> getUserByUserName(String userName) {
        return userRepository.findByUserName(userName);
    }

    public User createUser(String userName, String email) {
        if (userRepository.existsByUserName(userName)) {
            throw new RuntimeException("Username already exists: " + userName);
        }
        User user = new User(userName, email);
        return userRepository.save(user);
    }

    @CacheEvict(value = "users", key = "#id")
    public User updateUser(Long id, String email) {
        User user = getUser(id);
        user.setEmail(email);
        return userRepository.save(user);
    }

    @CacheEvict(value = "users", key = "#id")
    public void deleteUser(Long id) {
        User user = getUser(id);
        user.setStatus(UserStatus.DELETED);
        userRepository.save(user);
    }

    @Transactional(readOnly = true)
    public List<User> getAllActiveUsers() {
        return userRepository.findAll();
    }
}
