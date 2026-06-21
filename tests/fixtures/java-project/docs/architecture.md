# User Management Architecture

## Overview

The user management module handles user CRUD operations, authentication, and authorization.

## Components

### UserController

REST controller exposing user management endpoints:

- `GET /api/users/{id}` - Get user by ID
- `GET /api/users` - List all active users
- `POST /api/users` - Create a new user
- `PUT /api/users/{id}` - Update user email
- `DELETE /api/users/{id}` - Soft delete user

### UserService

Business logic layer for user operations:

- User creation with duplicate username check
- Cached user retrieval (`users` cache)
- Transactional user updates
- Soft delete (status changed to DELETED)

### UserRepository

JPA repository extending `JpaRepository<User, Long>`:

- `findByUserName(String userName)` - Find user by username
- `findByEmail(String email)` - Find user by email
- `existsByUserName(String userName)` - Check username availability

### User Entity

JPA entity mapped to `t_user` table:

| Field | Type | Column | Constraints |
|-------|------|--------|-------------|
| id | Long | id | PK, auto-generated |
| userName | String | user_name | NOT NULL, max 50 |
| email | String | email | NOT NULL |
| status | UserStatus | status | ENUM |

### UserStatus Enum

Status values: ACTIVE, INACTIVE, SUSPENDED, DELETED

## Data Flow

```
UserController → UserService → UserRepository → Database
                    ↓
              Cache (Redis)
```

## Security

- All endpoints require authentication
- Admin role required for user deletion
- Rate limiting applied to create/update endpoints
