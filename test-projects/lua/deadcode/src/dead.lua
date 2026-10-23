local dead = {}

function dead.first(a, ignored)
    local unused = 1
    return a
end

function dead.second()
    do
        return 1
    end
    print("never")
end

return dead
