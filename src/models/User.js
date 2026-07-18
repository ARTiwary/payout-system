const { v4: uuid } = require('uuid');

class User {
  constructor({ userKey, name = null, email = null }) {
    this.id = uuid();
    this.userKey = userKey;
    this.name = name;
    this.email = email;
    this.createdAt = new Date();
  }
}

module.exports = { User };
