local greet = require("greet")

describe("greet", function()
    it("says hello", function()
        assert.are.equal("Hello, Ada!", greet.hello("Ada"))
    end)

    it("knows a shout", function()
        assert.is_true(greet.shouted("HI"))
        assert.is_false(greet.shouted("Hi"))
    end)
end)
