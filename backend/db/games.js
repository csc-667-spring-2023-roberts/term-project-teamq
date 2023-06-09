const db = require("./connection.js");
const prompt=require("prompt-sync")({sigint:true}); 

const CREATE_GAME_SQL =
  "INSERT INTO games(closed, number_of_players) VALUES (false, 1) RETURNING id";
const INSERT_FIRST_USER_SQL =
  "INSERT INTO game_users(user_id, game_id, current_player) VALUES ($1, $2, true)";
const UPDATE_PLAYER_COUNT_SQL =
  "UPDATE games SET number_of_players = number_of_players + 1 WHERE id = $1";
const BUILD_DECK =
  "INSERT INTO card_hand (user_id, game_id, uno_card_id) SELECT 0, $1, id FROM uno_cards ORDER BY RANDOM()";
const DRAW_7 =
  "UPDATE card_hand SET user_id=$2 WHERE id IN (SELECT id FROM card_hand WHERE user_id=0 AND game_id=$1 LIMIT 7)";
const DISCARD =
  "UPDATE card_hand SET user_id=-1 WHERE game_id=$1 AND uno_card_id=$2";
const DISCARD_MOAR =
  "UPDATE card_hand SET user_id=user_id - 1 WHERE game_id=$1 AND user_id < 0";
const INIT_GAMEBOARD = "INSERT INTO gameboard (game_id) VALUES ($1)";

const create = async (creator_id) => {
  const { id } = await db.one(CREATE_GAME_SQL);
  await db.none(INIT_GAMEBOARD, [id]);
  await db.none(INSERT_FIRST_USER_SQL, [creator_id, id]);
  await db.none(BUILD_DECK, [id]);
  await db.none(DRAW_7, [id, creator_id]);

  const {uno_card_id} = await db.one(
    "SELECT ch.uno_card_id FROM card_hand AS ch JOIN uno_cards AS uc ON ch.uno_card_id = uc.id WHERE user_id=0 AND game_id=$1 AND uc.card_number < 10 LIMIT 1",
    [id]
  );
  

  const card_info = await db.one("SELECT * FROM uno_cards WHERE uno_cards.id=$1",[uno_card_id]);
  await db.none("UPDATE gameboard SET board_color=$1, board_number=$2 WHERE game_id=$3",[card_info.card_color, card_info.card_number, id]);
  await db.none(DISCARD, [id, uno_card_id]);

  return { id };
};

const GAMES_LIST_SQL = `
  SELECT g.id FROM games g, game_users gu 
  WHERE g.id=gu.game_id AND gu.user_id != $1 AND 
  (SELECT COUNT(*) FROM game_users WHERE game_users.game_id=g.id) = 1
`;

const list = async (user_id) => db.any(GAMES_LIST_SQL, [user_id]);

const JOIN_GAME_SQL =
  "INSERT INTO game_users (game_id, user_id) VALUES ($1, $2)";
const join = async (game_id, user_id) => {
  await db.none(JOIN_GAME_SQL, [game_id, user_id]);
  await db.none(DRAW_7, [game_id, user_id]);
};
const updatePlayerCount = (game_id) => {
  db.none(UPDATE_PLAYER_COUNT_SQL, [game_id]);
};

const countPlayers = (game_id) =>
  db.one("SELECT COUNT(*) FROM game_users WHERE game_id=$1", [game_id]);

const GAME_PLAYERS =
  "SELECT id, username, email, game_users.current_player FROM users, game_users WHERE game_users.user_id=users.id AND game_users.game_id=$1";

const state = async (game_id) => {
  // players in the game
  // which player's turn it is
  const player_data = await db.many(GAME_PLAYERS, [game_id]);
  // cards in the players hands
  const hands_data = await db.many(
    "SELECT * FROM card_hand, uno_cards WHERE card_hand.game_id=$1 AND card_hand.user_id IN ($2:csv) AND uno_cards.id=card_hand.uno_card_id",
    [game_id, player_data.map((p) => p.id)]
  );

  const hands = hands_data.reduce((memo, card) => {
    memo[card.user_id] = memo[card.user_id] || [];
    memo[card.user_id].push(card);

    return memo;
  }, {});

  //console.log("PLAYER DATA: " + player_data[0].id + ": " + player_data[0].current_player ,player_data[1].id + ": " + player_data[1].current_player);
  const players = player_data.map((player) => ({
    ...player,
    card_count: hands[player.id].length,
  }));

  //console.log("PLAYERS: " + players[0].id + ": " + players[0].current_player ,players[1].id + ": " + players[1].current_player);

  const connections = await db.any(
    "SELECT * FROM user_sockets WHERE game_id=$1 AND user_id IN ($2:csv)",
    [game_id, players.map((p) => p.id)]
  );

  // card on top of the discard pile
  const discard_card = await db.one(
    "SELECT * FROM card_hand, uno_cards WHERE card_hand.game_id=$1 AND card_hand.user_id=-1 AND uno_cards.id=card_hand.uno_card_id",
    [game_id]
  );

  // table direction
  const gameboard = await db.one("SELECT * FROM gameboard WHERE game_id=$1",[game_id]);

  return {
    lookup: (user_id) => ({
      game_id,
      me: user_id,
      connection: connections.find(
        (connection) => connection.user_id === user_id
      ),
      players: players.map((player) => ({
        me: player.id === user_id,
        ...player,
        card_count: hands[player.id].length,
      })),
      hand: hands[user_id],
      discard_card,
      gameboard,
    }),
    connections,
  };
};


const checkValidPlayer = (game_id, user_id) => {
  return db.one("SELECT COUNT(*) FROM game_users WHERE game_id=$1 AND user_id=$2", [game_id, user_id])
  .then(result => {
    const count = parseInt(result.count);
    return count;
  })
  .catch(error => {
    console.error(error);
  });
}

const checkPlayerTurn = (game_id, user_id) => {
  return db.one("SELECT COUNT(*) FROM game_users WHERE game_id=$1 AND user_id=$2 AND current_player=true", [game_id, user_id])
  .then(result => {
    const count = parseInt(result.count);
    return count;
  })
  .catch(error => {
    console.error(error);
  });
}

const getDiscardCard = (game_id) => {
  return db.one("SELECT card_hand.uno_card_id FROM card_hand WHERE user_id=-1 AND game_id=$1", [game_id])
  .then(result => {
    const discard_card_id = parseInt(result.uno_card_id);
    return discard_card_id;
  })
  .catch(error => {
    console.error(error);
  });
}

const checkValidCard = (color, number, gameboard_color, gameboard_number) => {
  console.log(color, number, gameboard_color, gameboard_number);
  if(number == 13 || number == 14)
  {
    return 1;
  }
  else if(color == gameboard_color || number == gameboard_number)
  {
    return 1;
  }
  else
  {
    return 0;
  }
};

const playCard = (game_id, user_id, discard_card_id, uno_card_id) => {
  db.none("UPDATE card_hand SET user_id = -2 WHERE game_id=$1 AND uno_card_id=$2", [game_id, discard_card_id]);
  db.none("UPDATE card_hand SET user_id = -1 WHERE game_id=$1 AND user_id=$2 AND uno_card_id=$3", [game_id, user_id, uno_card_id]);
};

const checkHandCount = (game_id, user_id) => {
  return db.one("SELECT COUNT(*) FROM card_hand WHERE game_id=$1 AND user_id=$2", [game_id, user_id])
  .then(result => {
    const hand_count = parseInt(result.count)
    return hand_count
  })
  .then(hand_count => {
    if(hand_count == 0)
    {
      return 1;
    }
    else
    {
      return 0;
    }
  })
}

const getNextPlayerIndex = (currentIndex, numPlayers, clockwise) => {
  if(clockwise)
  {
    return (currentIndex + 1) % numPlayers;
  }
  else
  {
    return (currentIndex + numPlayers - 1) % numPlayers;
  }
}

const updatePlayerTurnFalse = (game_id, current_player_id) => {
  db.none("UPDATE game_users SET current_player=false WHERE game_id=$1 AND user_id=$2", [game_id, current_player_id]);
}

const updatePlayerTurnTrue = (game_id, next_player_id) => {
  db.none("UPDATE game_users SET current_player=true WHERE game_id=$1 AND user_id=$2", [game_id, next_player_id]);
}

const updateGameDirection = (game_id, clockwise) => {
  db.none("UPDATE gameboard SET clockwise=$1 WHERE game_id=$2", [!clockwise, game_id]);
}

const playPlusTwoCard = (game_id, next_player_id) => 
{
  db.none("UPDATE card_hand SET user_id=$2 WHERE id IN (SELECT id FROM card_hand WHERE user_id=0 AND game_id=$1 LIMIT 2)", [game_id, next_player_id]);
}

const playPlusFourCard = (game_id, next_player_id) => 
{
  db.none("UPDATE card_hand SET user_id=$2 WHERE id IN (SELECT id FROM card_hand WHERE user_id=0 AND game_id=$1 LIMIT 4)", [game_id, next_player_id]);
}

const drawCard = (game_id, user_id) => 
{
  db.none("UPDATE card_hand SET user_id=$2 WHERE id IN (SELECT id FROM card_hand WHERE user_id=0 AND game_id=$1 LIMIT 1)", [game_id, user_id]);
}

const updateGameColorAndNumber = (color, number, game_id) => {
  db.none("UPDATE gameboard SET board_color=$1, board_number=$2 WHERE game_id=$3", [color, number, game_id]);
}

function getUserInput() {
  let wrongInput = true;
  let userInput;

  while(wrongInput)
  {
    userInput = prompt("Please enter a number to choose a color (1 = Red, 2 = Yellow, 3 = Green, 4 = Blue): ")
    if(userInput != 1 || userInput != 2 || userInput != 3 || userInput != 4)
    {
      continue;
    }
    else
    {
      wrongInput = false
    }
  }
  return userInput;
}

module.exports = { create, list, join, updatePlayerCount, countPlayers, state, 
  checkValidPlayer, checkPlayerTurn, getDiscardCard, checkValidCard, playCard, checkHandCount,
  getNextPlayerIndex, updatePlayerTurnFalse, updatePlayerTurnTrue, updateGameDirection, playPlusTwoCard, updateGameColorAndNumber,
  playPlusFourCard, drawCard};
