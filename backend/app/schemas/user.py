from typing import Literal

from pydantic import BaseModel, EmailStr, Field

Role = Literal["user", "admin"]


class ProfileUpdate(BaseModel):
    full_name: str = Field(min_length=1, max_length=150)


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=72)


class SetActiveRequest(BaseModel):
    is_active: bool


class AdminUserCreate(BaseModel):
    full_name: str = Field(min_length=1, max_length=150)
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)
    role: Role = "user"


class AdminUserUpdate(BaseModel):
    full_name: str = Field(min_length=1, max_length=150)
    email: EmailStr
    role: Role
